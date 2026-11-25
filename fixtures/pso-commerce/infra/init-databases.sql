-- one PostgreSQL server, one database per service (a service never reads another service's database)
CREATE DATABASE customers;
CREATE DATABASE catalog;
CREATE DATABASE orders;
