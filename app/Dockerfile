FROM node:22.16.0-slim

WORKDIR /usr/src/app

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY * ./

RUN npm install
RUN npm run build

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
