#!/bin/sh
# 校园网断线自动重连（方案B）
# 用法: /root/campus/monitor.sh
LOG=/tmp/campus_monitor.log

# 互斥锁：避免与 cron 并发触发
LOCK=/tmp/campus_monitor.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# 1) 在线检测：百度返回 200 视为已联网
if curl -s -m 8 -o /dev/null -w '%{http_code}' https://www.baidu.com 2>/dev/null | grep -q '200'; then
  exit 0
fi

echo "$(date '+%F %T') 检测到断线，尝试自动登录" >> $LOG

# 2) 获取 WAN IP（优先取默认路由源地址，回退找运营商 CGN 网段，如 100.64.x.x / 100.96.x.x）
WANIP=$(ip route get 1.1.1.1 2>/dev/null | head -1 | grep -o 'src [0-9.]*' | cut -d' ' -f2)
[ -z "$WANIP" ] && WANIP=$(ip addr show 2>/dev/null | grep -o 'inet 100\.96\.[0-9.]*' | head -1 | awk '{print $2}')

if [ -z "$WANIP" ]; then
  echo "$(date '+%F %T') 未获取到 WAN IP，跳过" >> $LOG
  exit 1
fi

echo "$(date '+%F %T') WAN IP=$WANIP，执行登录..." >> $LOG
cd /root/campus && node login.js "$WANIP" >> $LOG 2>&1
echo "$(date '+%F %T') 登录脚本退出码=$?" >> $LOG
