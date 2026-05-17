FROM postgres:17-alpine

# Build-time dependencies for pgvector
RUN apk add --no-cache --virtual .build-deps \
    git \
    build-base \
    clang19 \
    llvm19-dev

# Clone and build pgvector
RUN cd /tmp && \
    git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git && \
    cd pgvector && \
    make NO_BC=1 && \
    make NO_BC=1 install && \
    cd .. && \
    rm -rf pgvector

# Remove build-time dependencies
RUN apk del .build-deps
