APP = dist/Useful Bot.app

.PHONY: build test icon bundle clean

build:
	swift build -c release

# Delegate to test.sh so the CLT/Xcode framework search path and the
# TestingInterop copy stay in one place instead of drifting here.
test:
	./test.sh

icon:
	cd .. && npm run brand:build

bundle:
	./build-app.sh

clean:
	rm -rf .build dist
