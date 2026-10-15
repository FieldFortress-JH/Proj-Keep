# Breeze MDM Server — Apple MDM protocol sidecar
# Multi-stage build for a minimal production image

# ─── Build stage ───
FROM golang:1.23-alpine AS builder

WORKDIR /build

# Install build dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files first (better layer caching)
COPY go.mod go.sum* ./

# Download dependencies
RUN go mod download || true

# Copy source
COPY . .

# Build static binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o mdm-server .

# ─── Production stage ───
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# Copy binary from builder
COPY --from=builder /build/mdm-server /app/mdm-server

# Create certs directory
RUN mkdir -p /certs

# Non-root user
RUN addgroup -g 1000 mdm && adduser -u 1000 -G mdm -s /bin/sh -D mdm
USER mdm

EXPOSE 8443

ENTRYPOINT ["/app/mdm-server"]
