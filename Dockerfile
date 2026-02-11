FROM postgres:17-alpine

# Build-time dependencies for pgvector
RUN apk add --no-cache --virtual .build-deps \
    git \
    build-base \
    clang \
    llvm-dev

# Clone and build pgvector
RUN cd /tmp && \
    git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git && \
    cd pgvector && \
    make && \
    make install && \
    cd .. && \
    rm -rf pgvector

# Remove build-time dependencies
RUN apk del .build-deps
