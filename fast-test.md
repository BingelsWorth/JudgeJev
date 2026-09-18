$baseUrl = "http://localhost:8000"
$model = "Qwen/Qwen3-1.7B"
$maxOutputTokens = 256

$tests = @(
    @{ Name = "2k";  Target = 2048  },
    @{ Name = "4k";  Target = 4096  },
    @{ Name = "8k";  Target = 8192  },
    @{ Name = "16k"; Target = 16000 }
)

$concurrencies = @(1, 3, 5)

# Long-ish block used to build contexts.
$base = @"
This is independent software engineering context for evaluating a proposed implementation.
Review architecture, correctness, maintainability, performance, concurrency, resource usage,
failure handling, edge cases, security, observability, testing strategy, and operational risks.
Consider possible implementation mistakes, hidden assumptions, scaling behavior, race conditions,
and whether the proposed solution actually satisfies the requested behavior.
"@

$task = @"

TASK:
Review the supplied engineering context. Then write a Python function that finds duplicate
values in a list and briefly explain its time and space complexity.
"@

function Get-PromptTokenCount {
    param([string]$Prompt)

    $body = @{
        model = $model
        prompt = $Prompt
    } | ConvertTo-Json -Depth 10

    try {
        $r = Invoke-RestMethod `
            -Uri "$baseUrl/tokenize" `
            -Method POST `
            -ContentType "application/json" `
            -Body $body

        if ($null -ne $r.count) {
            return [int]$r.count
        }

        if ($null -ne $r.tokens) {
            return [int]$r.tokens.Count
        }
    }
    catch {
        return $null
    }

    return $null
}

function Build-Prompt {
    param(
        [int]$TargetTokens,
        [int]$RequestNumber,
        [bool]$Unique
    )

    # Start from our previously observed chars/token ratio.
    $charsPerToken = 6.0
    $targetChars = [int]($TargetTokens * $charsPerToken)

    if ($Unique) {
        $prefix = "UNIQUE REQUEST $RequestNumber. DATASET-$RequestNumber. "
        $block = $prefix + $base
    }
    else {
        $block = $base
    }

    $builder = New-Object System.Text.StringBuilder

    while ($builder.Length -lt $targetChars) {
        [void]$builder.Append($block)
    }

    $prompt = $builder.ToString()

    if ($prompt.Length -gt $targetChars) {
        $prompt = $prompt.Substring(0, $targetChars)
    }

    $prompt += $task

    return $prompt
}

function Run-Test {
    param(
        [string]$Mode,
        [string]$ContextName,
        [int]$TargetTokens,
        [int]$Concurrency
    )

    Write-Host "Running $Mode | $ContextName | C=$Concurrency ..."

    $sharedPrompt = $null

    if ($Mode -eq "SAME") {
        $sharedPrompt = Build-Prompt `
            -TargetTokens $TargetTokens `
            -RequestNumber 1 `
            -Unique $false
    }

    $wall = [Diagnostics.Stopwatch]::StartNew()

    $jobs = 1..$Concurrency | ForEach-Object {

        $requestNumber = $_

        if ($Mode -eq "SAME") {
            $prompt = $sharedPrompt
        }
        else {
            $prompt = Build-Prompt `
                -TargetTokens $TargetTokens `
                -RequestNumber $requestNumber `
                -Unique $true
        }

        Start-Job -ScriptBlock {

            param(
                $RequestNumber,
                $Prompt,
                $Model,
                $BaseUrl,
                $MaxOutputTokens
            )

            $body = @{
                model = $Model
                messages = @(
                    @{
                        role = "user"
                        content = $Prompt
                    }
                )
                max_tokens = $MaxOutputTokens
                temperature = 0.7
            } | ConvertTo-Json -Depth 10

            $timer = [Diagnostics.Stopwatch]::StartNew()

            try {
                $r = Invoke-RestMethod `
                    -Uri "$BaseUrl/v1/chat/completions" `
                    -Method POST `
                    -ContentType "application/json" `
                    -Body $body

                $timer.Stop()

                [PSCustomObject]@{
                    Request      = $RequestNumber
                    Success      = $true
                    Seconds      = $timer.Elapsed.TotalSeconds
                    PromptTokens = $r.usage.prompt_tokens
                    OutputTokens = $r.usage.completion_tokens
                    Error        = ""
                }
            }
            catch {
                $timer.Stop()

                [PSCustomObject]@{
                    Request      = $RequestNumber
                    Success      = $false
                    Seconds      = $timer.Elapsed.TotalSeconds
                    PromptTokens = 0
                    OutputTokens = 0
                    Error        = $_.Exception.Message
                }
            }

        } -ArgumentList `
            $requestNumber,
            $prompt,
            $model,
            $baseUrl,
            $maxOutputTokens
    }

    $results = $jobs | Receive-Job -Wait -AutoRemoveJob
    $wall.Stop()

    $successful = @($results | Where-Object Success -eq $true)

    if ($successful.Count -eq 0) {
        return [PSCustomObject]@{
            Mode            = $Mode
            Prompt          = $ContextName
            PromptTokens    = 0
            Concurrency     = $Concurrency
            WallSec         = [math]::Round($wall.Elapsed.TotalSeconds, 2)
            AvgReqSec       = 0
            OutputTokens    = 0
            AggregateTokSec = 0
            PerRequestTokSec = 0
        }
    }

    $avgPrompt = (
        $successful.PromptTokens |
        Measure-Object -Average
    ).Average

    $avgReq = (
        $successful.Seconds |
        Measure-Object -Average
    ).Average

    $totalOutput = (
        $successful.OutputTokens |
        Measure-Object -Sum
    ).Sum

    $aggregate = $totalOutput / $wall.Elapsed.TotalSeconds

    $perRequest = (
        $successful |
        ForEach-Object {
            $_.OutputTokens / $_.Seconds
        } |
        Measure-Object -Average
    ).Average

    return [PSCustomObject]@{
        Mode             = $Mode
        Prompt           = $ContextName
        PromptTokens     = [math]::Round($avgPrompt)
        Concurrency      = $Concurrency
        WallSec          = [math]::Round($wall.Elapsed.TotalSeconds, 2)
        AvgReqSec        = [math]::Round($avgReq, 2)
        OutputTokens     = $totalOutput
        AggregateTokSec  = [math]::Round($aggregate, 1)
        PerRequestTokSec = [math]::Round($perRequest, 1)
    }
}

$summary = @()

# ------------------------------------------------------------
# SAME PROMPT / PREFIX CACHE FRIENDLY
# ------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host " SAME PROMPTS - PREFIX CACHE FRIENDLY"
Write-Host "============================================================"

foreach ($test in $tests) {
    foreach ($c in $concurrencies) {
        $summary += Run-Test `
            -Mode "SAME" `
            -ContextName $test.Name `
            -TargetTokens $test.Target `
            -Concurrency $c
    }
}

# ------------------------------------------------------------
# UNIQUE PROMPTS / NO SHARED PREFIX
# ------------------------------------------------------------

Write-Host ""
Write-Host "============================================================"
Write-Host " UNIQUE PROMPTS - NO SHARED PREFIX"
Write-Host "============================================================"

foreach ($test in $tests) {
    foreach ($c in $concurrencies) {
        $summary += Run-Test `
            -Mode "UNIQUE" `
            -ContextName $test.Name `
            -TargetTokens $test.Target `
            -Concurrency $c
    }
}

# ------------------------------------------------------------
# FULL RESULTS
# ------------------------------------------------------------

Write-Host ""
Write-Host "======================= FULL RESULTS ======================="

$summary |
    Format-Table `
        Mode,
        Prompt,
        PromptTokens,
        Concurrency,
        WallSec,
        AvgReqSec,
        OutputTokens,
        AggregateTokSec,
        PerRequestTokSec `
        -AutoSize

# ------------------------------------------------------------
# AGGREGATE THROUGHPUT MATRICES
# ------------------------------------------------------------

foreach ($mode in @("SAME", "UNIQUE")) {

    Write-Host ""
    Write-Host "=========== $mode - AGGREGATE OUTPUT TOK/S ==========="

    foreach ($test in $tests) {

        $rows = $summary |
            Where-Object {
                $_.Mode -eq $mode -and
                $_.Prompt -eq $test.Name
            }

        [PSCustomObject]@{
            Prompt = $test.Name
            C1 = ($rows | Where-Object Concurrency -eq 1).AggregateTokSec
            C3 = ($rows | Where-Object Concurrency -eq 3).AggregateTokSec
            C5 = ($rows | Where-Object Concurrency -eq 5).AggregateTokSec
        }
    } |
    Format-Table -AutoSize
}

# ------------------------------------------------------------
# WALL CLOCK MATRICES
# ------------------------------------------------------------

foreach ($mode in @("SAME", "UNIQUE")) {

    Write-Host ""
    Write-Host "=============== $mode - WALL SECONDS ==============="

    foreach ($test in $tests) {

        $rows = $summary |
            Where-Object {
                $_.Mode -eq $mode -and
                $_.Prompt -eq $test.Name
            }

        [PSCustomObject]@{
            Prompt = $test.Name
            C1 = ($rows | Where-Object Concurrency -eq 1).WallSec
            C3 = ($rows | Where-Object Concurrency -eq 3).WallSec
            C5 = ($rows | Where-Object Concurrency -eq 5).WallSec
        }
    } |
    Format-Table -AutoSize
}

# ------------------------------------------------------------
# DIRECT SAME VS UNIQUE COMPARISON AT C5
# ------------------------------------------------------------

Write-Host ""
Write-Host "=============== PREFIX CACHE IMPACT @ C5 ==============="

foreach ($test in $tests) {

    $same = $summary |
        Where-Object {
            $_.Mode -eq "SAME" -and
            $_.Prompt -eq $test.Name -and
            $_.Concurrency -eq 5
        }

    $unique = $summary |
        Where-Object {
            $_.Mode -eq "UNIQUE" -and
            $_.Prompt -eq $test.Name -and
            $_.Concurrency -eq 5
        }

    [PSCustomObject]@{
        Prompt          = $test.Name
        ActualTokens    = $unique.PromptTokens
        SameTokSec      = $same.AggregateTokSec
        UniqueTokSec    = $unique.AggregateTokSec
        SameWallSec     = $same.WallSec
        UniqueWallSec   = $unique.WallSec
    }
} |
Format-Table -AutoSize