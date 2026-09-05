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

# 1) 在线检测
#    说明：curl 探测外网时流量会被 openclash（redir-host 模式）接管，
#    校园网真实掉线时探测仍可能返回 200，造成"假在线"导致长时间不自愈。
#    ICMP（ping）不被 mihomo 劫持，走内核真实路径：掉线时全 loss、在线时畅通。
#    轮流 ping 多个公网 IP（阿里/腾讯公共 DNS），任一可达即视为在线，避免单点误判。
#    注意：若 openclash 改用 TUN 模式（ICMP 也被代理），请换回其他探测方式。
for _ping_ip in 223.5.5.5 119.29.29.29; do
  if ping -q -c 3 -W 2 "$_ping_ip" >/dev/null 2>&1; then
    exit 0
  fi
done
echo "$(date '+%F %T') 公网 ping 全失败（223.5.5.5 / 119.29.29.29），判定掉线" >> $LOG

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
