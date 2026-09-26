# Final21 Faz 19: istemci araçları sunucu ana sürümüyle AYNI olmalı. İmaj PostgreSQL 16 istemcisi taşıyordu,
# tüm dağıtımlar PostgreSQL 18 çalıştırıyor; pg_dump 16 daha yeni sunucuyu reddeder ("aborting
# because of server version mismatch") — hiçbir yedek başarılı olamıyordu (ölçüldü).
FROM postgres:18-alpine

RUN apk add --no-cache \
    bash \
    rsync \
    python3 \
    py3-pip \
    tzdata \
  && pip3 install --quiet --break-system-packages awscli \
  && rm -rf /root/.cache

ENV TZ=Europe/Istanbul

COPY backup.sh /usr/local/bin/backup.sh
COPY scheduler.sh /usr/local/bin/scheduler.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/scheduler.sh

# Her gece BACKUP_AT'te (varsayılan 02:30). Cron daemon'u KULLANILMAZ: üretim sertleştirmesinde
# dcron "setpgid: Operation not permitted" döngüsüne girip hiçbir işi çalıştırmıyordu
# (nedeni backup/scheduler.sh'de). PID 1 bir init olmalı (compose: `init: true`).
CMD ["/usr/local/bin/scheduler.sh"]
