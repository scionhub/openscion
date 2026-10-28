FROM scn-need/build
WORKDIR /workspace
ENV NODE_PATH=/opt/worker/node_modules:/opt/api-ci/node_modules
ENV OPENSCION_SERVER=/usr/local/bin/openscion-server
# Runner injects CI=1, SCN_*, and GitHub-compatible vars at run time.
CMD ["/bin/sh", "-lc", "exec /opt/api-ci/node_modules/.bin/tsx /workspace/tools/api-ci/run.ts"]
