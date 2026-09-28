# Per-run egress proxy (spec B §5, ruling 1): CONNECT only to the hosts in the run's filter file,
# which the Desk mounts at /etc/tinyproxy/filter (the agent's: api.anthropic.com + approved research
# domains; the research browser's: approved research domains only). FilterURLs On: a filter line
# (`^host:443$`) matches the whole request target, so only HTTPS CONNECT to port 443 passes — plain HTTP
# (`http://host/…`) and any other port are refused (review fix 1, verified on tinyproxy 1.11.2).
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
USER 65534:65534
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
