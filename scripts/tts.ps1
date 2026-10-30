param (
    [string]$Text,
    [string]$OutputFile,
    [string]$VoiceName = "Microsoft Zira Desktop",
    [int]$Rate = 0
)

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

try {
    $synth.SelectVoice($VoiceName)
} catch {
    Write-Warning "Voice $VoiceName not found, using default voice."
}

$synth.Rate = $Rate
$synth.SetOutputToWaveFile($OutputFile)
$synth.Speak($Text)
$synth.Dispose()

Write-Output "Generated audio file: $OutputFile"
