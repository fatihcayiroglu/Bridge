FROM postgres:16-alpine

RUN apk add --no-cache \
    bash \
    rsync \
    python3 \
    py3-pip \
    tzdata \
    dcron \
  && pip3 install --quiet --break-system-packages awscli \
  && rm -rf /root/.cache

ENV TZ=Europe/Istanbul

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Her gece 02:30'da çalış
RUN echo "30 2 * * * /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1" \
    > /var/spool/cron/crontabs/root

CMD ["crond", "-f", "-l", "2"]
