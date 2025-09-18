FROM node:22.17-alpine3.21 AS dependencies

WORKDIR /workspace

RUN apk update && apk add vim && rm -rf /var/cache/apk/*
