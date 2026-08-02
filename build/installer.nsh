; Nimbus NSIS customisation.
;
; One job: work out what this machine can do while the installer is still on
; screen, so the first launch already knows whether to fetch the CUDA, ROCm,
; Vulkan or CPU transcription build instead of guessing and re-downloading.
;
; The probe is attempted elevated. Nimbus installs per-user by default and so
; runs unelevated, while a few of the values worth having -- per-adapter
; qwMemorySize for every card, not just the one this account can see -- read
; better as administrator. Elevation is therefore attempted and its refusal
; ignored: the same script runs unelevated straight afterwards if the prompt is
; declined, and the app re-probes on first run in any case. A declined UAC
; prompt must never fail an install.

!macro customInstall
  ; $LOCALAPPDATA is per-user and stays readable after a per-machine install
  ; drops privileges, which is where the app looks first.
  CreateDirectory "$LOCALAPPDATA\Nimbus"
  StrCpy $R0 "$LOCALAPPDATA\Nimbus\hardware.json"
  StrCpy $R1 '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\probe-hardware.ps1" -Out "$R0"'

  DetailPrint "Checking this computer's graphics and memory..."

  ; ExecShellWait with "runas" raises UAC when we are not already elevated and
  ; is a plain start when we are. SW_HIDE keeps the console window off screen.
  ClearErrors
  ExecShellWait "runas" "powershell.exe" "$R1" SW_HIDE

  ; Declined, or PowerShell is locked down: fall back to an unelevated run.
  IfFileExists "$R0" probe_done 0
  ClearErrors
  nsExec::ExecToStack 'powershell.exe $R1'
  Pop $R2

probe_done:
  IfFileExists "$R0" 0 probe_missing
  DetailPrint "Hardware profile written to $R0"
  ; A second copy beside the install, for the per-machine case where the
  ; account that installed is not the account that will run Nimbus.
  CopyFiles /SILENT "$R0" "$INSTDIR\hardware.json"
  Goto probe_end

probe_missing:
  ; Not fatal by design: src/hardware.js probes again on first run.
  DetailPrint "Could not read the hardware profile. Nimbus will check again on first launch."

probe_end:
!macroend

!macro customUnInstall
  ; The probe is derived data about this machine, not user content.
  Delete "$LOCALAPPDATA\Nimbus\hardware.json"
  Delete "$INSTDIR\hardware.json"
!macroend
