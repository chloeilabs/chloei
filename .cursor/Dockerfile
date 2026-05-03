FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/usr/local/node/bin:${PATH}"
ARG NODE_VERSION=24.15.0

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
    curl --retry 3 --retry-delay 5 -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    curl --retry 3 --retry-delay 5 -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/SHASUMS256.txt && \
    cd /tmp && grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c - && \
    tar -xJf "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local/node --strip-components=1 && \
    rm "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" /tmp/SHASUMS256.txt && \
    corepack enable && \
    corepack prepare pnpm@10.32.1 --activate

RUN useradd -m -s /bin/bash cursor && \
    usermod -aG sudo cursor && \
    echo "cursor ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/cursor && \
    chmod 0440 /etc/sudoers.d/cursor
