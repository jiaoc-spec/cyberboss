# Apple Calendar Helper

CyberBoss can read Apple Calendar through a small background macOS app instead of
depending on the Calendar permission of Terminal or the process that launched
CyberBoss.

## Install

```bash
npm run calendar-helper:install
```

When macOS asks for Calendar access, choose **Allow Full Access**. The helper is
installed at `~/Applications/CyberBoss Calendar Helper.app` and starts
automatically through a user LaunchAgent.

It refreshes `~/.cyberboss/apple-calendar-cache.json` every five minutes.
CyberBoss reads this cache first and falls back to the direct Swift reader only
when the cache is missing, stale, or unavailable.

Optional environment variables:

```bash
CYBERBOSS_APPLE_CALENDAR_CACHE_FILE=~/.cyberboss/apple-calendar-cache.json
CYBERBOSS_APPLE_CALENDAR_CACHE_MAX_AGE_MS=900000
CYBERBOSS_APPLE_CALENDAR_PREFER_CACHE=true
```
