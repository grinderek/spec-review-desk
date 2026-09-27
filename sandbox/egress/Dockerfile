# Per-run egress proxy (spec B §5, ruling 1): CONNECT only to the hosts in the run's filter file,
# which the Desk mounts at /etc/tinyproxy/filter (api.anthropic.com + approved research domains).
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
USER 65534:65534
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
