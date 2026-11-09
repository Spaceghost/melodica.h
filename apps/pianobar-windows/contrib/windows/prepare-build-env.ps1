# Prepares thedmd/pianobar-windows-build for a melodica.h build of this checkout.
#
#   prepare-build-env.ps1 -BuildEnv <dir> -Source <this repo checkout>
#
# Clones the upstream MSVC build environment into -BuildEnv (if absent), points
# its pianobar\src at -Source, and rewrites pianobar\pianobar.vcxproj so the
# libpiano sources come from vendor\melodica\compat instead of src\libpiano.
# Every substitution must match, otherwise the script fails: upstream drift
# should be noticed, not silently built around.
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $BuildEnv,
    [Parameter(Mandatory)] [string] $Source,
    [string] $BuildEnvRepo = 'https://github.com/thedmd/pianobar-windows-build.git',
    [string] $BuildEnvRef = 'master'
)
$ErrorActionPreference = 'Stop'

$Source = (Resolve-Path $Source).Path
if (-not (Test-Path (Join-Path $Source 'vendor\melodica\compat\piano.c'))) {
    throw "vendor\melodica submodule is not checked out under $Source"
}

if (-not (Test-Path (Join-Path $BuildEnv 'pianobar.sln'))) {
    git clone --quiet --depth 1 --branch $BuildEnvRef $BuildEnvRepo $BuildEnv
    if ($LASTEXITCODE -ne 0) { throw 'clone of build environment failed' }
}
$BuildEnv = (Resolve-Path $BuildEnv).Path

$srcLink = Join-Path $BuildEnv 'pianobar\src'
if (Test-Path $srcLink) { Remove-Item -Recurse -Force $srcLink }
New-Item -ItemType Junction -Path $srcLink -Target $Source | Out-Null

$proj = Join-Path $BuildEnv 'pianobar\pianobar.vcxproj'
$xml = Get-Content -Raw $proj

function Replace-Exactly([string] $text, [string] $old, [string] $new, [int] $count) {
    $parts = $text.Split($old)
    if ($parts.Count - 1 -ne $count) {
        throw "expected $count occurrence(s) of '$old' in pianobar.vcxproj, found $($parts.Count - 1)"
    }
    return $parts -join $new
}

$melodicaInc = '$(ProjectDir)src\vendor\melodica\include\;$(ProjectDir)src\vendor\melodica\compat\;'
$xml = Replace-Exactly $xml '$(ProjectDir)src\src\libpiano\;' $melodicaInc 2
$xml = Replace-Exactly $xml '$(ProjectDir)src\src\libpiano;' $melodicaInc 2

$oldCompile = @'
    <ClCompile Include="src\src\libpiano\crypt.c" />
    <ClCompile Include="src\src\libpiano\list.c" />
    <ClCompile Include="src\src\libpiano\piano.c" />
    <ClCompile Include="src\src\libpiano\request.c" />
    <ClCompile Include="src\src\libpiano\response.c" />
'@
$newCompile = @'
    <ClCompile Include="src\vendor\melodica\compat\blowfish.c" />
    <ClCompile Include="src\vendor\melodica\compat\crypt.c" />
    <ClCompile Include="src\vendor\melodica\compat\json.c" />
    <ClCompile Include="src\vendor\melodica\compat\piano.c" />
    <ClCompile Include="src\src\listenbrainz.c" />
    <ClCompile Include="src\src\listenbrainz_winhttp.c" />
    <ClCompile Include="src\src\listen_uri.c" />
    <ClCompile Include="src\src\listen.c" />
'@
$xml = Replace-Exactly $xml $oldCompile $newCompile 1

$oldInclude = @'
    <ClInclude Include="src\src\libpiano\crypt.h" />
    <ClInclude Include="src\src\libpiano\piano.h" />
    <ClInclude Include="src\src\libpiano\piano_private.h" />
'@
$newInclude = @'
    <ClInclude Include="src\vendor\melodica\include\melodica.h" />
    <ClInclude Include="src\vendor\melodica\include\piano.h" />
    <ClInclude Include="src\vendor\melodica\compat\blowfish.h" />
    <ClInclude Include="src\vendor\melodica\compat\crypt.h" />
    <ClInclude Include="src\vendor\melodica\compat\json.h" />
    <ClInclude Include="src\src\listenbrainz.h" />
    <ClInclude Include="src\src\listenbrainz_winhttp.h" />
    <ClInclude Include="src\src\listen_uri.h" />
    <ClInclude Include="src\src\listen.h" />
'@
$xml = Replace-Exactly $xml $oldInclude $newInclude 1

# blowfish and json-c are replaced by melodica's compat layer.
$oldRefs = @'
    <ProjectReference Include="..\blowfish\blowfish.vcxproj">
      <Project>{f0b7d905-bd81-4998-8386-333389be15de}</Project>
      <ReferenceOutputAssembly>false</ReferenceOutputAssembly>
    </ProjectReference>
    <ProjectReference Include="..\json-c\json-c.vcxproj">
      <Project>{65ab4e50-81ef-4bc4-bba4-8ec4315ada3f}</Project>
      <ReferenceOutputAssembly>false</ReferenceOutputAssembly>
    </ProjectReference>
'@
$xml = Replace-Exactly $xml $oldRefs '' 1

[System.IO.File]::WriteAllText($proj, $xml)
Write-Host "build environment ready at $BuildEnv (source: $Source)"
