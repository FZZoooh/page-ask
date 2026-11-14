@{
  # RightHandMan 托盘文案（zh-CN）。
  # 只放用户可见文本；Write-Tray 的日志保持英文，便于排查。
  AppName                = 'RightHandMan'
  TrayTooltip            = 'RightHandMan 后端'

  StatusRunning          = '运行中 127.0.0.1:{0}{1}'
  StatusModelSuffix      = ' {0}'
  NotifyRunning          = 'RightHandMan 后端：运行中'
  StatusPortForeign      = '端口 {0} 被其他程序占用'
  NotifyPortForeign      = 'RightHandMan：端口被占用'
  StatusStoppedManual    = '已停止（手动）'
  NotifyStoppedManual    = 'RightHandMan 后端：已停止（手动）'
  StatusStopped          = '已停止'
  NotifyStopped          = 'RightHandMan 后端：已停止'

  MenuStatus             = '状态'
  MenuStart              = '启动后端'
  MenuStop               = '停止后端'
  MenuRestart            = '重启后端'
  MenuConfig             = '配置…'
  MenuLogs               = '打开日志'
  MenuData               = '打开数据目录'
  MenuAutostart          = '开机自启'
  MenuQuit               = '退出'

  BalloonAbnormal        = '上次后端未正常退出'
  BalloonRecovered       = '后端已恢复'

  AutostartShortcutName  = 'PageAsk Tray.lnk'
  AutostartDescription   = 'RightHandMan 后端托盘（守护进程）'
  HostAutostartInstalled = '已设置开机自启：{0}'
  HostAutostartRemoved   = '已取消开机自启'
  HostAlreadyRunning     = 'RightHandMan 托盘已在运行（端口 {0}）'

  BgStarted              = '已在后台启动托盘：pid={0}（{1}）'
  BgLog                  = '日志：{0}'
  BgStop                 = '停止：托盘图标右键 → 退出；或 Stop-Process -Id 该 pid'
  BgMissing              = '找不到托盘脚本：{0}'
}
