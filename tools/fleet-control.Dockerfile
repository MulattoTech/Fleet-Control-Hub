FROM node:24-bookworm@sha256:8fa96264f302f58bbb13aa7339c541547b56975766ce956c875da149452a3e40
WORKDIR /app
COPY projects.json ./
COPY src/fleet-tracker.js src/published-acceptance.js src/project-desktop-activity.js ./src/
COPY tools/serve-fleet-control.js ./tools/
ENV FLEET_CONTROL_ADDRESS=0.0.0.0 FLEET_CONTROL_PORT=8081 FLEET_CONTROL_SNAPSHOT_ROOT=/observations
USER node
EXPOSE 8081
CMD ["node", "tools/serve-fleet-control.js"]
