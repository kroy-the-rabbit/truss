GO       ?= $(shell command -v go 2>/dev/null || echo go)
BUF      ?= buf
NPM      ?= npm
VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "0.1.0-dev")

BACKEND_DIR := backend
APP_DIR     := app
BIN_DIR     := $(BACKEND_DIR)/bin

# Go cross-compile targets: OS/ARCH → binary path
# electron-builder expects: backend/bin/{os}/{arch}/trussd[.exe]
# electron-builder uses: linux, mac, win  and  x64, arm64
# Go uses:               linux, darwin, windows  and  amd64, arm64

.PHONY: proto backend backend-dev backend-all frontend dev build clean \
        package package-linux package-mac package-win \
        backend-linux-x64 backend-linux-arm64 \
        backend-mac-x64 backend-mac-arm64 \
        backend-win-x64 backend-win-arm64

# ---------- Protobuf ----------

proto:
	cd $(BACKEND_DIR) && $(BUF) generate

# ---------- Backend (Go) ----------

# Build for current platform (development)
backend-dev:
	cd $(BACKEND_DIR) && $(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o trussd ./cmd/trussd

# Cross-compile helpers — each writes to bin/{eb-os}/{eb-arch}/trussd[.exe]
backend-linux-x64:
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
		$(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o bin/linux/x64/trussd ./cmd/trussd

backend-linux-arm64:
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
		$(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o bin/linux/arm64/trussd ./cmd/trussd

backend-mac-x64:
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 \
		$(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o bin/mac/x64/trussd ./cmd/trussd

backend-mac-arm64:
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
		$(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o bin/mac/arm64/trussd ./cmd/trussd

backend-win-x64:
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
		$(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o bin/win/x64/trussd.exe ./cmd/trussd

backend-win-arm64:
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=windows GOARCH=arm64 \
		$(GO) build -ldflags="-s -w -X main.version=$(VERSION)" -o bin/win/arm64/trussd.exe ./cmd/trussd

# Build all platforms
backend-all: backend-linux-x64 backend-linux-arm64 backend-mac-x64 backend-mac-arm64 backend-win-x64 backend-win-arm64

# Default "backend" = dev build
backend: backend-dev

# ---------- Frontend ----------

frontend:
	cd $(APP_DIR) && $(NPM) install && $(NPM) run build

# ---------- Development ----------

dev: backend-dev
	cd $(APP_DIR) && VITE_DEV_SERVER_URL=http://localhost:5173 npx vite

# ---------- Packaging ----------

# Package for Linux (AppImage, x64+arm64)
package-linux: backend-linux-x64 backend-linux-arm64 frontend
	cd $(APP_DIR) && npx electron-builder --linux

# Package for macOS (DMG, x64+arm64)
package-mac: backend-mac-x64 backend-mac-arm64 frontend
	cd $(APP_DIR) && npx electron-builder --mac

# Package for Windows (NSIS installer, x64+arm64)
package-win: backend-win-x64 backend-win-arm64 frontend
	cd $(APP_DIR) && npx electron-builder --win

# Package for all platforms
package: backend-all frontend
	cd $(APP_DIR) && npx electron-builder --linux --mac --win

# ---------- Utilities ----------

clean:
	rm -f $(BACKEND_DIR)/trussd $(BACKEND_DIR)/trussd.exe
	rm -rf $(BIN_DIR)
	rm -rf $(APP_DIR)/dist
	rm -rf release

test:
	cd $(BACKEND_DIR) && $(GO) test ./...

fmt:
	cd $(BACKEND_DIR) && $(GO) fmt ./...
