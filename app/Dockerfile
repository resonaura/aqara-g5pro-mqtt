FROM node:22.16.0-slim

WORKDIR /usr/src/app

COPY * ./

RUN npm install

COPY src ./src

RUN npm run build

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD ["/run.sh"]
