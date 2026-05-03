FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/usr/local/node/bin:${PATH}"

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      openssh-client \
      postgresql \
      postgresql-contrib \
      python3 \
      ripgrep \
      sudo \
      xz-utils && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/local/node && \
    curl --retry 3 --retry-delay 5 -fsSL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz -o /tmp/node-v24.tar.xz && \
    tar -xJf /tmp/node-v24.tar.xz -C /usr/local/node --strip-components=1 && \
    rm /tmp/node-v24.tar.xz && \
    corepack enable && \
    corepack prepare pnpm@10.32.1 --activate
