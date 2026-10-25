FROM scn-need/build
WORKDIR /workspace
CMD ["/bin/sh", "-lc", "test -f /root/base.txt && echo \"needs example: OK\" && exit 0 || (echo \"missing base\"; exit 1)"]
