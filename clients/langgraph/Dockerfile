FROM python:3.12-slim

WORKDIR /app

# 先装依赖，利用镜像层缓存（requirements 不变则不重装）
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 再拷源码与前端
COPY app ./app
COPY web ./web

# 监听端口由 PORT 环境变量决定（缺省 8100）；__main__ 会先载 .env 再起 uvicorn
EXPOSE 8100
CMD ["python", "-m", "app"]
