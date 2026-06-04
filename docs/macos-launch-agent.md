# macOS LaunchAgent

CyberBoss can run as a macOS user background service so the Terminal window does
not need to stay open.

```bash
npm run launch-agent:install
```

The installer creates:

- `~/Library/LaunchAgents/com.jiaoc.cyberboss.bridge.plist`
- `~/.cyberboss/logs/launch-agent.out.log`
- `~/.cyberboss/logs/launch-agent.err.log`

The service starts when the user logs in and restarts if the bridge exits.
Configuration remains in the project `.env`; secrets are not copied into the
LaunchAgent plist.

The Mac must still be awake and connected to the network. Locking the screen is
fine. Normal MacBook sleep or powered-off state stops Telegram replies until the
Mac wakes again.
