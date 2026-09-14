#!/bin/bash
# 在镜像里装 Oracle Instant Client（Linux x64），供 node-oracledb 的 Thick 模式使用。
#
# 为什么需要：本项目要连的 Oracle 服务端版本较旧，驱动的 Thin 模式会被服务端直接拒掉
# （NJS-138: not supported by node-oracledb in Thin mode）。带一份客户端进镜像，
# 容器就不必依赖宿主机上装没装、是哪个平台的客户端。
#
# 三种来源按顺序找：
#   1. docker/oracle/instantclient-basiclite-linux.x64-*.zip（本地放好的，随构建上下文带进来）
#   2. /tmp/oracle-ic.zip（构建参数传进来的）
#   3. Oracle 官方源下载（公司网络慢/被挡时用前两种）
set -euo pipefail

INSTALL_DIR=/opt/oracle
IC_VERSION=23.4.0.24.05
IC_ZIP="instantclient-basiclite-linux.x64-${IC_VERSION}.zip"
IC_URL="https://download.oracle.com/otn_software/linux/instantclient/2340000/${IC_ZIP}"

mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

if [[ -f "/docker/oracle/${IC_ZIP}" ]]; then
  echo "使用构建上下文里的 ${IC_ZIP}"
  cp "/docker/oracle/${IC_ZIP}" .
elif ls /docker/oracle/instantclient-basiclite-linux.x64-*.zip >/dev/null 2>&1; then
  echo "使用构建上下文里的 basiclite zip（版本不限）"
  cp "$(ls /docker/oracle/instantclient-basiclite-linux.x64-*.zip | head -1)" "${IC_ZIP}"
elif [[ -f /tmp/oracle-ic.zip ]]; then
  echo "使用构建参数传入的 Instant Client zip"
  cp /tmp/oracle-ic.zip "${IC_ZIP}"
else
  echo "从 Oracle 官方源下载 Instant Client ${IC_VERSION} …"
  if ! curl -fsSL "${IC_URL}" -o "${IC_ZIP}"; then
    echo "下载失败。把 ${IC_ZIP} 放到 docker/oracle/ 后重新构建即可（不再走网络）。" >&2
    exit 1
  fi
fi

unzip -q "${IC_ZIP}"
rm -f "${IC_ZIP}"

IC_DIR="$(ls -d instantclient_* 2>/dev/null | head -1)"
if [[ -z "${IC_DIR}" ]]; then
  echo "解压后没找到 instantclient_* 目录。" >&2
  exit 1
fi
# 固定成一个稳定路径：容器的 ORACLE_CLIENT_LIB_DIR 指向它，换版本不用改配置。
ln -sfn "${INSTALL_DIR}/${IC_DIR}" "${INSTALL_DIR}/instantclient"
echo "Oracle Instant Client 就绪：${INSTALL_DIR}/instantclient（${IC_DIR}）"
