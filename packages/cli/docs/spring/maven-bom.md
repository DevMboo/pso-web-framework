---
title: Maven BOM and Java versions
description: How the distributed and source-checkout CLIs select matching PSO Java artifacts, and how Maven builds resolve them.
order: 2
status: implemented
keywords: [bom, pso-bom, snapshot, java:install, maven, version, release, dependencyManagement]
related: [spring/overview, microservices/maven-dependencies, devops/docker]
---
Generated services import one bill of materials and then declare starters without individual versions. The **installed `0.2.0-rc.8` CLI** sets `pso.version` to `0.2.0-rc.8`; the **framework checkout** reads the current `pso-java/pom.xml`, which is `0.1.0-SNAPSHOT` in this checkout. The CLI selects a matching Java version instead of adopting whichever artifacts happen to be on the machine:

```xml
<properties>
  <pso.version>0.2.0-rc.8</pso.version>
</properties>
<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.pso</groupId>
      <artifactId>pso-bom</artifactId>
      <version>${pso.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>
```

The `pso.version` property is the only place a PSO version appears. Spring Boot itself stays managed by `spring-boot-starter-parent` 3.5.6 (Java 21 target).

## Install the matching artifacts

```bash
pso java:install        # installed rc.8: copies its bundled com.pso:*:0.2.0-rc.8 repository into ~/.m2
pso create service catalog
```

No JAR is copied by hand. The rc.8 portable distribution includes a Maven file repository next to the CLI. If your authorized package ships it separately, run `pso java:install --from <maven-repository-dir>`. `pso create service` reports when matching artifacts are missing. In a **framework checkout**, `pso java:install` builds `pso-java/` and installs `0.1.0-SNAPSHOT`; after changing the starters there, run it again. Do not substitute the checkout's SNAPSHOT for a distributed rc.8 service.

The group id `com.pso` is **not** an owned Maven Central namespace: the artifacts are never published from this repository. Choose and register a namespace before publishing.

## Releases

Production builds must use an immutable version: set `pso.version` to a release, never a `-SNAPSHOT`. `pso security:audit` reports SNAPSHOT dependencies and `pso deploy` refuses to deploy a SNAPSHOT build.

## Containers

`docker:init` builds a Spring service inside a Docker build, where your local `~/.m2` is not visible. Use `pso docker:init --vendor` to copy the matching artifacts into the service for its image build, or provide a Maven repository the build can reach. Container builds with vendored artifacts are covered by the [Docker workflow](/devops/docker); the PSO artifacts are not on Maven Central.

## Common mistakes

- Overriding a Spring Boot-managed version next to the PSO BOM.
- Building in a container without a repository that has the `com.pso` artifacts ([Maven dependencies](/microservices/maven-dependencies)).
- Deploying a `-SNAPSHOT` `pso.version` (refused by `pso deploy`).

## Next steps

- [Maven dependencies](/microservices/maven-dependencies)
- [Build and deploy](/devops/build-and-deploy)
