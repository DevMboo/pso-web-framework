---
title: Why Spring Boot remains independent
description: Services are ordinary Spring Boot applications.
order: 8
keywords: [decision, spring boot, independence, microservices]
related: [microservices/spring-boot-integration]
---
## Context

A framework that replaces the application's container, security or persistence layer locks teams in and makes services hard to hand over or debug.

## Decision

Generated services are plain Spring Boot: Spring's context, Spring Security, Actuator, Jakarta Validation, JUnit and the Maven Wrapper. PSO contributes generators, naming conventions and validation around them, not a runtime inside them. Each service is built, tested and deployed independently, owns its data and shares only versioned contracts.

## Consequences

- Any Spring developer can work on a service; any service can be moved out of a workspace.
- The service does depend on the first-party PSO starters ([Spring Boot starters](/spring/overview)) for security, limits and configuration, but they are ordinary Spring Boot auto-configuration: every bean backs off when you define your own, and nothing scans your packages. The Dispatch provider starters (Redis, RabbitMQ, Kafka) are separate, optional modules you install per service.
- A shared version (`pso-bom`) replaces copied code: upgrading means changing one property.

## What it looks like in practice

Open the generated `pom.xml` and `Application.java`: it is a Spring Boot 3.5 project with the Spring Boot parent, the PSO BOM and starters, and a normal `@SpringBootApplication`. Its tests run with `./mvnw test` and need nothing from PSO's CLI (a generated service's own tests run with the Maven Wrapper alone; in the [CRUD tutorial](/tutorials/crud-api) run they passed together with the example's tests under `./mvnw test`).

```java
@SpringBootApplication
public class Application { public static void main(String[] args) { SpringApplication.run(Application.class, args); } }
```

## The cost

The services depend on PSO starters for security, limits, problems and logging. They are auto-configuration that backs off when you define your own beans, but they are a dependency you must keep upgraded with the BOM version.

## When to revisit

If a PSO starter ever needs to replace a Spring mechanism instead of configuring it, that is a signal to reconsider: the principle is "configure Spring, do not replace it".
