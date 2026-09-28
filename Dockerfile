FROM node:20-bookworm

# 1. Install LibreDWG dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    wget \
    tar \
    gzip \
    && rm -rf /var/lib/apt/lists/*

# 2. Compile and Install LibreDWG (using 0.13.3, latest stable)
ARG LIBREDWG_VERSION=0.13.3
RUN wget -q "https://ftp.gnu.org/gnu/libredwg/libredwg-${LIBREDWG_VERSION}.tar.gz" \
    && tar -xzf "libredwg-${LIBREDWG_VERSION}.tar.gz" \
    && cd "libredwg-${LIBREDWG_VERSION}" \
    && ./configure --disable-bindings --prefix=/usr/local \
    && make -j$(nproc) \
    && make install \
    && ldconfig \
    && cd .. \
    && rm -rf libredwg*

# 3. Setup Node.js app
WORKDIR /app

# Copy package info and install
COPY package*.json ./
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Set the entrypoint to our TSX test runner
ENTRYPOINT ["npx", "tsx", "src/extractors/dwg-to-json/index.ts"]
