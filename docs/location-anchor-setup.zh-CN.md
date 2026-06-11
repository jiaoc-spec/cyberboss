# 定位锚点设置（到家自动触发 Playbook）

配好之后，**到家这件事会自动触发预设动作提示**，不再需要你说"到家了"。
桥接端代码已经接好（arrive_home → 状态记录 + Playbook 提示），只差两步配置。

## 第一步：Mac 端开启定位服务

在 `~/.cyberboss/.env` 里加上（家的坐标可以在 Apple 地图里长按家的位置查看）：

```dotenv
CYBERBOSS_ENABLE_LOCATION_SERVER=true
CYBERBOSS_LOCATION_TOKEN=换成一段随机长字符串
CYBERBOSS_LOCATION_HOME_CENTER=纬度,经度
```

然后重启桥接：

```bash
launchctl kickstart -k gui/$(id -u)/com.jiaoc.cyberboss.bridge
```

验证：`curl http://localhost:4318/healthz` 应返回 ok。

## 第二步：iPhone 快捷指令自动化

1. 打开"快捷指令"App → 自动化 → 新建自动化 → **到达** → 选"家"的位置 → 立即运行
2. 自动化动作里依次添加：
   - **获取当前位置**
   - **获取 URL 内容**：
     - URL：`http://<Mac的局域网IP>:4318/location/ingest`
     - 方法：POST
     - 头部：`Authorization: Bearer <第一步的token>`
     - 请求体（JSON）：
       ```json
       {
         "latitude": 当前位置的纬度,
         "longitude": 当前位置的经度,
         "trigger": "arrive_home",
         "source": "shortcuts",
         "deviceName": "iPhone"
       }
       ```
3. 同样可以再建一个"离开家"的自动化，`trigger` 填 `leave_home`。

注意：手机和 Mac 需要在同一局域网（家里 Wi-Fi），所以"到家"触发时正好能连上。

## 验证

到家后（或手动运行一次快捷指令），看日志：

```bash
grep "current state asserted\|playbook trigger" ~/.cyberboss/logs/launch-agent.out.log | tail -5
```

应出现 `current state asserted state=arrived_home source=location` 和 `playbook trigger queued`。
