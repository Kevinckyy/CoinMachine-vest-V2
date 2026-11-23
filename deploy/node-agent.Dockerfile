FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
COPY node_agent.py /opt/vest/node_agent.py
ENTRYPOINT ["python", "-Bu", "/opt/vest/node_agent.py"]
