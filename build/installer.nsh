; EclipseLiveCam installer additions: register / remove the virtual camera.
;
; The camera is a DirectShow filter (softcam, rebranded). Registering it is
; what makes "EclipseLiveCam" appear in Zoom, Meet, Discord, OBS … It needs
; admin rights, which is why the installer is per-machine.
;
; Both the 64-bit and 32-bit filters are registered so 32-bit apps see it too.
; CLSID must match native/patch-softcam.mjs and src/main/vcam.js.
!include x64.nsh

!define VCAM_CLSID "{4C23FA8E-932C-4342-92E8-7F3EDA72F4BA}"
; DirectShow "Video Capture Sources" category. softcam registers the camera
; there under its friendly name (Instance\EclipseLiveCam).
!define VCAM_CATEGORY "{860BB310-5D01-11d0-BD3B-00A0C911CE86}"

!macro customInstall
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s "$INSTDIR\resources\vcam\x64\softcam.dll"'
  ${EnableX64FSRedirection}
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s "$INSTDIR\resources\vcam\x86\softcam.dll"'
!macroend

!macro customUnInstall
  ; Try a clean unregister first, then remove the keys directly in case the
  ; DLLs are already gone, so no dead camera is left behind.
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$WINDIR\System32\regsvr32.exe" /s /u "$INSTDIR\resources\vcam\x64\softcam.dll"'
  ${EnableX64FSRedirection}
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s /u "$INSTDIR\resources\vcam\x86\softcam.dll"'
  SetRegView 64
  DeleteRegKey HKCR "CLSID\${VCAM_CLSID}"
  DeleteRegKey HKCR "CLSID\${VCAM_CATEGORY}\Instance\EclipseLiveCam"
  SetRegView 32
  DeleteRegKey HKCR "CLSID\${VCAM_CLSID}"
  DeleteRegKey HKCR "CLSID\${VCAM_CATEGORY}\Instance\EclipseLiveCam"
  SetRegView lastused
!macroend
