FROM postgres:16-alpine

# Container always listens on the standard 5432 internally; the host-side
# "strange" port mapping lives in docker-compose.yml so 5432 stays free on
# the host machine for other local Postgres use.
EXPOSE 5432
