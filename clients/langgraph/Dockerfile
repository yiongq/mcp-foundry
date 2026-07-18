# LangGraph 前端生产镜像。network_mode host（见 docker-compose.yml），uvicorn 绑宿主 loopback。
# 硬化：基础镜像按摘要固定（Dependabot 升级）；非 root 运行；HEALTHCHECK 探 /api/config。
# uvicorn 自带 SIGTERM/SIGINT 优雅关闭处理器，无需 tini。
FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

WORKDIR /app

# 先装依赖，利用镜像层缓存（requirements 不变则不重装）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 源码与前端
COPY app ./app
COPY web ./web

# 非 root 运行
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin app \
  && chown -R app:app /app
USER app

# 监听端口由 PORT 决定（缺省 8100）；__main__ 先载 .env 再起 uvicorn
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8100')+'/api/config', timeout=3)"
CMD ["python", "-m", "app"]
