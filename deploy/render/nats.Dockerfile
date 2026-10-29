FROM nats:2.14.3-alpine
COPY deploy/render/nats.conf /etc/nats/nats.conf
CMD ["--config", "/etc/nats/nats.conf"]
