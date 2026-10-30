# 通过 GitHub API 推送本地提交（当本机无法直连 github.com:443 时用）
# 用法：pwsh -File scripts/gh-push.ps1 -Message "提交说明" [-BaseTag published]
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$BaseTag = "published",
  [string]$Owner = "skkjkk",
  [string]$Repo = "my-blog"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$remoteSha = (gh api "repos/$Owner/$Repo/commits/main" --jq .sha).Trim()
$baseTree = (gh api "repos/$Owner/$Repo/git/commits/$remoteSha" --jq .tree.sha).Trim()
$localHead = (git rev-parse HEAD).Trim()

$lines = git diff --name-status $BaseTag HEAD
if (-not $lines) {
  Write-Output "没有需要推送的改动"
  exit 0
}

$tmp = [System.IO.Path]::GetTempPath()
$utf8 = New-Object System.Text.UTF8Encoding($false)
$entries = @()

foreach ($line in $lines) {
  $parts = $line -split "`t"
  $status = $parts[0]
  $path = $parts[1]

  if ($status -eq "D") {
    $entries += @{ path = $path; mode = "100644"; type = "blob"; sha = $null }
    Write-Output "删除 $path"
    continue
  }

  cmd /c "git cat-file blob $localHead`:$path > `"$tmp\gh-blob.bin`"" | Out-Null
  $bytes = [System.IO.File]::ReadAllBytes("$tmp\gh-blob.bin")
  $payload = @{ content = [Convert]::ToBase64String($bytes); encoding = "base64" } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText("$tmp\gh-blob.json", $payload, $utf8)
  $sha = (gh api --method POST "repos/$Owner/$Repo/git/blobs" --input "$tmp\gh-blob.json" --jq .sha).Trim()
  $entries += @{ path = $path; mode = "100644"; type = "blob"; sha = $sha }
  Write-Output "写入 $path ($($bytes.Length) 字节)"
}

$treeBody = @{ base_tree = $baseTree; tree = $entries } | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText("$tmp\gh-tree.json", $treeBody, $utf8)
$treeSha = (gh api --method POST "repos/$Owner/$Repo/git/trees" --input "$tmp\gh-tree.json" --jq .sha).Trim()

$commitBody = @{ message = $Message; tree = $treeSha; parents = @($remoteSha) } | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText("$tmp\gh-commit.json", $commitBody, $utf8)
$newCommit = (gh api --method POST "repos/$Owner/$Repo/git/commits" --input "$tmp\gh-commit.json" --jq .sha).Trim()

$refBody = @{ sha = $newCommit; force = $false } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("$tmp\gh-ref.json", $refBody, $utf8)
gh api --method PATCH "repos/$Owner/$Repo/git/refs/heads/main" --input "$tmp\gh-ref.json" --jq ".object.sha" | Out-Null

git tag -f $BaseTag HEAD | Out-Null
Write-Output "已推送：$($newCommit.Substring(0,7)) $Message"
