; electron/assets/installer.nsh — included by electron-builder's NSIS script.
;
; Final21 Phase 12, measured on an installed build: the app registered bridge://
; itself at first launch (HKCU\Software\Classes\bridge) and the uninstaller left
; that key behind, pointing at a deleted Bridge.exe. The installer now registers
; the protocol (links work before the first launch) and the uninstaller removes
; it — but only when the handler still points into THIS installation, so another
; program's bridge:// handler is never deleted.

!macro bridgeRegisterProtocol ROOT
  WriteRegStr ${ROOT} "Software\Classes\bridge" "" "URL:Bridge Protocol"
  WriteRegStr ${ROOT} "Software\Classes\bridge" "URL Protocol" ""
  WriteRegStr ${ROOT} "Software\Classes\bridge\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr ${ROOT} "Software\Classes\bridge\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro bridgeRemoveOwnProtocol ROOT
  ReadRegStr $0 ${ROOT} "Software\Classes\bridge\shell\open\command" ""
  StrLen $2 "$INSTDIR"
  ; The command is '"<INSTDIR>\Bridge.exe" "%1"': compare the path after the opening quote.
  StrCpy $1 $0 $2 1
  StrCmp $1 "$INSTDIR" 0 +2
    DeleteRegKey ${ROOT} "Software\Classes\bridge"
!macroend

!macro customInstall
  !insertmacro bridgeRegisterProtocol SHCTX
!macroend

; "Start with Windows" (app.setLoginItemSettings) writes a Run value named after the
; AppUserModelId. Left behind, Windows would try to start a deleted Bridge.exe at
; every sign-in. Removed only when it points into this installation.
!macro bridgeRemoveOwnStartup
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.bridge.desktop"
  StrLen $2 "$INSTDIR"
  StrCpy $1 $0 $2 1
  StrCmp $1 "$INSTDIR" 0 +2
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.bridge.desktop"
!macroend

!macro customUnInstall
  !insertmacro bridgeRemoveOwnProtocol SHCTX
  ; Electron's app.setAsDefaultProtocolClient writes the per-user key at runtime.
  !insertmacro bridgeRemoveOwnProtocol HKCU
  ; An update runs the old uninstaller too; keep the user's startup choice then.
  ${ifNot} ${isUpdated}
    !insertmacro bridgeRemoveOwnStartup
  ${endIf}
!macroend
