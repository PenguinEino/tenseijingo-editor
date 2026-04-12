; Installer hooks for tenseijingo-editor
; Prevent app data deletion on uninstall regardless of checkbox state

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $DeleteAppDataCheckboxState 0
!macroend
