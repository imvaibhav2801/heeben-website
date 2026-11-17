FROM python:3.12-slim
WORKDIR /app
COPY . .
ENV HEEBEN_DEMO=0 HEEBEN_DB=/data/heeben.db HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["python3", "server.py"]
