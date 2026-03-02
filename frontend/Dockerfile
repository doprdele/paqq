FROM nginx:1.27-alpine

COPY . /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/00-runtime-config.sh /docker-entrypoint.d/00-runtime-config.sh

RUN chmod +x /docker-entrypoint.d/00-runtime-config.sh

EXPOSE 80
