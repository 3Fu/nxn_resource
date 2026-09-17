param(
  [Parameter(Mandatory = $true)]
  [string]$InputFile,

  [Parameter(Mandatory = $true)]
  [string]$OutputFile
)

$ErrorActionPreference = "Stop"
$InputFile = [IO.Path]::GetFullPath($InputFile)
$OutputFile = [IO.Path]::GetFullPath($OutputFile)

if (-not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
  throw "Input PPTX does not exist: $InputFile"
}

$outputDirectory = Split-Path -Parent $OutputFile
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($InputFile, $true, $false, $false)
  $presentation.SaveAs($OutputFile, 32)
}
finally {
  if ($null -ne $presentation) {
    $presentation.Close()
  }
  if ($null -ne $powerPoint) {
    $powerPoint.Quit()
  }
}

if (-not (Test-Path -LiteralPath $OutputFile -PathType Leaf)) {
  throw "PowerPoint did not create the PDF preview: $OutputFile"
}
