; electron-builder 自动包含的 NSIS 自定义脚本（build/installer.nsh）

; 安装目录不可写时（例如选了只有管理员才能写的 D:\2\software），electron-builder 会在复制文件阶段
; 连续重试后弹出「Pulse 无法关闭，请手动关闭后重试」—— 和真实原因完全无关，用户会去找一个根本没运行的 Pulse。
; 这里在复制文件之前先试写一次，写不进去就直接说明原因。之后照常走 electron-builder 默认的「应用是否在运行」检查。
; 定义了 customCheckAppRunning 后 electron-builder 就不再引入默认检查依赖的 getProcessInfo，这里补上
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    ClearErrors
    CreateDirectory "$INSTDIR"
    FileOpen $R8 "$INSTDIR\.pulse-write-test" w
    ${if} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "无法写入安装目录：$\r$\n$INSTDIR$\r$\n$\r$\n「仅为我安装」没有这个目录的写入权限。请重新运行安装程序，在第一步选择「为使用这台电脑的任何人安装」（需要管理员授权），或者换一个目录。" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endIf}
    FileClose $R8
    Delete "$INSTDIR\.pulse-write-test"
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
