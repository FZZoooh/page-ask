@{
  # RightHandMan tray strings (en-US).
  # Only user-visible text lives here; Write-Tray logs stay English.
  AppName                = 'RightHandMan'
  TrayTooltip            = 'RightHandMan backend'

  StatusRunning          = 'Running 127.0.0.1:{0}{1}'
  StatusModelSuffix      = ' {0}'
  NotifyRunning          = 'RightHandMan backend: running'
  StatusPortForeign      = 'Port {0} is in use by another program'
  NotifyPortForeign      = 'RightHandMan: port in use'
  StatusStoppedManual    = 'Stopped (manually)'
  NotifyStoppedManual    = 'RightHandMan backend: stopped (manually)'
  StatusStopped          = 'Stopped'
  NotifyStopped          = 'RightHandMan backend: stopped'

  MenuStatus             = 'Status'
  MenuStart              = 'Start backend'
  MenuStop               = 'Stop backend'
  MenuRestart            = 'Restart backend'
  MenuConfig             = 'Configure…'
  MenuLogs               = 'Open logs'
  MenuData               = 'Open data folder'
  MenuAutostart          = 'Start with Windows'
  MenuQuit               = 'Quit'

  BalloonAbnormal        = 'The backend did not shut down cleanly last time'
  BalloonRecovered       = 'Backend recovered'

  AutostartShortcutName  = 'PageAsk Tray.lnk'
  AutostartDescription   = 'RightHandMan backend tray (watchdog)'
  HostAutostartInstalled = 'Start with Windows enabled: {0}'
  HostAutostartRemoved   = 'Start with Windows disabled'
  HostAlreadyRunning     = 'RightHandMan tray is already running (port {0})'

  BgStarted              = 'Tray started in background: pid={0} ({1})'
  BgLog                  = 'Log: {0}'
  BgStop                 = 'To stop: right-click the tray icon → Quit; or Stop-Process -Id <pid>'
  BgMissing              = 'Tray script not found: {0}'
}
