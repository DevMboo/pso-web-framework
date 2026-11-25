import { column, names, sortFields, type FieldSpec, type ResourceSpec } from "./crud-spec.ts";

/**
 * The layered Spring Boot CRUD of one resource (official structure, 0.2.0):
 *
 *   application/rest/<R>Controller.java              HTTP: validation, authorization, status codes, Location
 *   application/service/<R>Service.java              business operations and transaction boundaries
 *   application/dto/request/Create<R>Request.java    validated request records (Jakarta Validation)
 *   application/dto/request/Update<R>Request.java
 *   application/dto/response/<R>Response.java        response record (the entity never leaves the service)
 *   application/dto/response/PageResponse.java       stable paginated contract (shared by every resource)
 *   application/mapper/<R>Mapper.java                request -> entity, entity -> response
 *   infrastructure/entity/<R>Entity.java             JPA entity
 *   infrastructure/persistence/<R>Repository.java    Spring Data repository (+ <R>Specifications: database-level filters)
 *   shared/exception/{ResourceNotFound,Conflict}Exception.java     RFC 9457 problems with a safe detail
 *   shared/validation/PageRequests.java              page, size and sort validation (allowed fields, maximum size)
 *   resources/db/migration/V<n>__create_<table>.sql  Flyway: table, constraints, indexes
 *   test/.../application/rest/<R>ControllerTests.java   real HTTP layer, JWT, PostgreSQL and Flyway
 */
export interface SpringCrudOptions {
  /** base package, e.g. com.example.products */
  pkg: string;
  /** Flyway version of the migration (the next free one) */
  migrationVersion: number;
  /** the service prefix (for test requests and docs): "/catalog", or "" for a service without prefix */
  servicePrefix: string;
  /** which shared files to (re)create: they are written once per service */
  withShared: boolean;
  /** the service refuses unknown JSON properties (spring.jackson.deserialization.fail-on-unknown-properties: true); default true */
  strictJson?: boolean;
  /** the reference resource carries the "removable example" notes */
  reference: boolean;
}

const javaType = (f: FieldSpec, forEntity = false): string =>
  ({ string: "String", text: "String", integer: "Integer", long: "Long", decimal: "BigDecimal", boolean: forEntity ? "boolean" : "Boolean" })[f.type];
const sqlType = (f: FieldSpec): string =>
  ({ string: `VARCHAR(${f.maxLength ?? 255})`, text: `VARCHAR(${f.maxLength ?? 10000})`, integer: "INTEGER", long: "BIGINT", decimal: `NUMERIC(${f.precision ?? 12}, ${f.scale ?? 2})`, boolean: "BOOLEAN" })[f.type];
const javaStr = (s: string): string => JSON.stringify(s);

/** a valid example value of a field, as a JSON literal, distinct for each n (unique fields) */
export function sample(f: FieldSpec, n: number): string {
  switch (f.type) {
    case "boolean": return f.defaultValue === false ? "false" : "true";
    case "integer": case "long": return String(Math.max(Number(f.min ?? 1), 1) + n);
    case "decimal": return javaStr((10 + n).toFixed(f.scale ?? 2));
    default: {
      if (f.name === "sku" || f.pattern) return javaStr(`KB-${100 + n}`);
      const base = f.unique ? `${f.name}-${100 + n}` : `Sample ${f.name} ${n}`;
      return javaStr(base.slice(0, f.maxLength ?? 255).padEnd(f.minLength ?? 0, "x"));
    }
  }
}

function validation(f: FieldSpec, update: boolean, imports: Set<string>): string[] {
  const a: string[] = [];
  const use = (cls: string) => imports.add(`jakarta.validation.constraints.${cls}`);
  const required = f.required || (update && f.type === "boolean"); // PUT replaces the whole resource: every field is given
  if (f.type === "string" || f.type === "text") {
    if (required) { use("NotBlank"); a.push("@NotBlank"); }
    use("Size"); a.push(`@Size(${f.minLength ? `min = ${f.minLength}, ` : ""}max = ${f.maxLength})`);
    if (f.pattern) { use("Pattern"); a.push(`@Pattern(regexp = ${javaStr(`^${f.pattern}$`)}${f.patternMessage ? `, message = ${javaStr(f.patternMessage)}` : ""})`); }
  } else {
    if (required) { use("NotNull"); a.push("@NotNull"); }
    if (f.type === "integer" || f.type === "long") {
      if (f.min !== undefined) { use("Min"); a.push(`@Min(${f.min})`); }
      if (f.max !== undefined) { use("Max"); a.push(`@Max(${f.max})`); }
    }
    if (f.type === "decimal") {
      use("Digits"); a.push(`@Digits(integer = ${(f.precision ?? 12) - (f.scale ?? 2)}, fraction = ${f.scale ?? 2})`);
      if (f.min !== undefined) { use("DecimalMin"); a.push(`@DecimalMin(${javaStr(f.min)})`); }
      if (f.max !== undefined) { use("DecimalMax"); a.push(`@DecimalMax(${javaStr(f.max)})`); }
    }
  }
  return a;
}

const head = (pkg: string, sub: string, imports: Iterable<string>): string => {
  // static imports first, then alphabetical (the order most Java formatters produce)
  const list = [...new Set(imports)].sort((a, b) => (a.startsWith("static ") === b.startsWith("static ") ? (a < b ? -1 : 1) : a.startsWith("static ") ? -1 : 1));
  return `package ${pkg}${sub ? `.${sub}` : ""};\n\n${list.map((i) => `import ${i};`).join("\n")}${list.length ? "\n\n" : ""}`;
};

/** Files of the shared foundation of a layered service (exceptions, paging): created once, never overwritten. */
export function springSharedFiles(pkg: string, o: { data?: boolean } = {}): Record<string, string> {
  const P = `src/main/java/${pkg.split(".").join("/")}`;
  const all = sharedFiles(pkg, P);
  // paging needs Spring Data: a service without a database keeps the exceptions only
  if (o.data === false) for (const k of Object.keys(all)) if (k.endsWith("/PageRequests.java") || k.endsWith("/PageResponse.java")) delete all[k];
  return all;
}

function sharedFiles(pkg: string, P: string): Record<string, string> {
  return {
    [`${P}/shared/exception/ResourceNotFoundException.java`]: `${head(pkg, "shared.exception", ["com.pso.spring.autoconfigure.problem.PsoProblemException", "org.springframework.http.HttpStatus"])}/**
 * A requested resource does not exist: 404 with the "not_found" problem (RFC 9457). The detail names the resource and its id,
 * never anything the caller did not send.
 */
public class ResourceNotFoundException extends PsoProblemException {

    public ResourceNotFoundException(String resource, Object id) {
        super(HttpStatus.NOT_FOUND, "not_found", resource + " " + id + " does not exist");
    }
}
`,
    [`${P}/shared/exception/ConflictException.java`]: `${head(pkg, "shared.exception", ["com.pso.spring.autoconfigure.problem.PsoProblemException", "org.springframework.http.HttpStatus"])}/** The request conflicts with the current state of a resource (a duplicate unique value, a concurrent change): 409 "conflict". */
public class ConflictException extends PsoProblemException {

    public ConflictException(String detail) {
        super(HttpStatus.CONFLICT, "conflict", detail);
    }
}
`,
    [`${P}/shared/exception/InvalidRequestException.java`]: `${head(pkg, "shared.exception", ["com.pso.spring.autoconfigure.problem.PsoProblemException", "org.springframework.http.HttpStatus"])}/** A request parameter is outside what the operation accepts (an unknown sort field, a page that is too large): 400 "bad_request". */
public class InvalidRequestException extends PsoProblemException {

    public InvalidRequestException(String detail) {
        super(HttpStatus.BAD_REQUEST, "bad_request", detail);
    }
}
`,
    [`${P}/shared/validation/PageRequests.java`]: `${head(pkg, "shared.validation", [`${pkg}.shared.exception.InvalidRequestException`, "java.util.Set", "org.springframework.data.domain.PageRequest", "org.springframework.data.domain.Pageable", "org.springframework.data.domain.Sort"])}/**
 * Builds a database-level page request from the query parameters of a list endpoint. The sort field must be one of the fields the
 * endpoint allows (sorting by anything else is refused, never passed to the database), the page size has a maximum, and the order
 * is always total: ties are broken by id so a page never repeats or skips a row.
 */
public final class PageRequests {

    private PageRequests() {
    }

    /**
     * @param sort "field" or "field,asc" or "field,desc"; null means the default
     */
    public static Pageable of(int page, int size, String sort, Set<String> allowedSort, String defaultSort, int maxSize) {
        if (page < 0) {
            throw new InvalidRequestException("page must be 0 or greater");
        }
        if (size < 1 || size > maxSize) {
            throw new InvalidRequestException("size must be between 1 and " + maxSize);
        }
        String value = sort == null || sort.isBlank() ? defaultSort : sort.strip();
        String[] parts = value.split(",", -1);
        String field = parts[0].strip();
        if (!allowedSort.contains(field)) {
            throw new InvalidRequestException("sort must be one of " + String.join(", ", allowedSort.stream().sorted().toList()));
        }
        Sort.Direction direction = Sort.Direction.ASC;
        if (parts.length == 2) {
            direction = switch (parts[1].strip().toLowerCase()) {
                case "asc" -> Sort.Direction.ASC;
                case "desc" -> Sort.Direction.DESC;
                default -> throw new InvalidRequestException("the sort direction must be asc or desc");
            };
        } else if (parts.length > 2) {
            throw new InvalidRequestException("sort is field or field,asc or field,desc");
        }
        return PageRequest.of(page, size, Sort.by(direction, field).and(Sort.by(Sort.Direction.ASC, "id")));
    }
}
`,
    [`${P}/application/dto/response/PageResponse.java`]: `${head(pkg, "application.dto.response", ["java.util.List", "org.springframework.data.domain.Page"])}/**
 * The paginated contract of every list endpoint: the items of the requested page and where it is in the whole result. It is a
 * documented, stable shape (the Spring Page type is an internal one and is never returned as is).
 */
public record PageResponse<T>(List<T> items, int page, int size, long totalItems, int totalPages) {

    public static <T> PageResponse<T> of(Page<T> page) {
        return new PageResponse<>(page.getContent(), page.getNumber(), page.getSize(), page.getTotalElements(), page.getTotalPages());
    }
}
`,
  };
}

export function springCrudFiles(r: ResourceSpec, o: SpringCrudOptions): Record<string, string> {
  const n = names(r);
  const { pkg } = o;
  const P = `src/main/java/${pkg.split(".").join("/")}`, T = `src/test/java/${pkg.split(".").join("/")}`;
  const R = n.Resource, ex = o.reference ? `\n *\n * Reference example generated by PSO: remove it with the files listed in docs/reference-crud.md (or keep it as a pattern).` : "";
  const uniq = r.fields.filter((f) => f.unique);
  const sorts = sortFields(r);
  const files: Record<string, string> = {};

  // ---------------------------------------------------------------- entity
  {
    const imp = new Set(["jakarta.persistence.Column", "jakarta.persistence.Entity", "jakarta.persistence.GeneratedValue", "jakarta.persistence.GenerationType", "jakarta.persistence.Id", "jakarta.persistence.Table", "jakarta.persistence.Version", "java.time.Instant", "java.util.UUID", "lombok.AccessLevel", "lombok.Getter", "lombok.NoArgsConstructor", "lombok.Setter", "org.hibernate.annotations.CreationTimestamp", "org.hibernate.annotations.UpdateTimestamp"]);
    if (r.fields.some((f) => f.type === "decimal")) imp.add("java.math.BigDecimal");
    const fields = r.fields.map((f) => {
      const col = [`name = ${javaStr(column(f))}`, f.required || f.type === "boolean" ? "nullable = false" : "", f.type === "string" || f.type === "text" ? `length = ${f.maxLength}` : "", f.type === "decimal" ? `precision = ${f.precision}, scale = ${f.scale}` : ""].filter(Boolean).join(", ");
      const init = f.type === "boolean" && f.defaultValue !== undefined ? ` = ${f.defaultValue}` : "";
      return `    @Setter\n    @Column(${col})\n    private ${javaType(f, true)} ${f.name}${init};`;
    }).join("\n\n");
    files[`${P}/infrastructure/entity/${R}Entity.java`] = `${head(pkg, "infrastructure.entity", imp)}/**
 * JPA entity of the ${n.table} table. It stays inside the service: controllers return ${R}Response, never this class.
 * The schema is owned by Flyway (db/migration); Hibernate only validates that this mapping matches it.${ex}
 */
@Entity
@Table(name = ${javaStr(n.table)})
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED) // for JPA only
public class ${R}Entity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

${fields}

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** optimistic locking: a concurrent update of the same row fails instead of silently overwriting the other one */
    @Version
    @Column(name = "version", nullable = false)
    private long version;

    /** a new, not yet persisted ${n.resource}: the id and the timestamps are assigned when it is saved */
    public static ${R}Entity create() {
        return new ${R}Entity();
    }
}
`;
  }

  // ---------------------------------------------------------------- repository + specifications
  files[`${P}/infrastructure/persistence/${R}Repository.java`] = `${head(pkg, "infrastructure.persistence", [`${pkg}.infrastructure.entity.${R}Entity`, "java.util.UUID", "org.springframework.data.jpa.repository.JpaRepository", "org.springframework.data.jpa.repository.JpaSpecificationExecutor"])}/** Spring Data repository: CRUD, paging and database-level filtering (JpaSpecificationExecutor) of ${n.table}. */
public interface ${R}Repository extends JpaRepository<${R}Entity, UUID>, JpaSpecificationExecutor<${R}Entity> {
${uniq.map((f) => `\n    boolean existsBy${f.name[0]!.toUpperCase()}${f.name.slice(1)}(${javaType(f)} ${f.name});\n\n    boolean existsBy${f.name[0]!.toUpperCase()}${f.name.slice(1)}AndIdNot(${javaType(f)} ${f.name}, UUID id);\n`).join("")}}
`;
  const filters = r.fields.filter((f) => f.filter);
  {
    const imp = new Set([`${pkg}.infrastructure.entity.${R}Entity`, "org.springframework.data.jpa.domain.Specification"]);
    const params = filters.map((f) => `${javaType(f)} ${f.name}`).join(", ");
    const parts = filters.map((f) => f.filter === "contains"
      ? `        if (${f.name} != null && !${f.name}.isBlank()) {\n            String like = "%" + ${f.name}.strip().toLowerCase().replace("\\\\", "\\\\\\\\").replace("%", "\\\\%").replace("_", "\\\\_") + "%";\n            spec = spec.and((root, query, cb) -> cb.like(cb.lower(root.get(${javaStr(f.name)})), like, '\\\\'));\n        }`
      : `        if (${f.name} != null${f.type === "string" ? ` && !${f.name}.isBlank()` : ""}) {\n            spec = spec.and((root, query, cb) -> cb.equal(root.get(${javaStr(f.name)}), ${f.name}${f.type === "string" ? ".strip()" : ""}));\n        }`).join("\n");
    files[`${P}/infrastructure/persistence/${R}Specifications.java`] = `${head(pkg, "infrastructure.persistence", imp)}/**
 * The filters of the list endpoint, evaluated by the database (WHERE clauses), never in memory. Text filters are case-insensitive
 * "contains" matches with the LIKE wildcards of the input escaped; unique and boolean fields match exactly.
 */
public final class ${R}Specifications {

    private ${R}Specifications() {
    }

    public static Specification<${R}Entity> matching(${params}) {
        Specification<${R}Entity> spec = (root, query, cb) -> cb.conjunction();
${parts}
        return spec;
    }
}
`;
  }

  // ---------------------------------------------------------------- request / response records
  for (const kind of ["Create", "Update"] as const) {
    const imp = new Set<string>();
    if (r.fields.some((f) => f.type === "decimal")) imp.add("java.math.BigDecimal");
    const comps = r.fields.map((f) => { const a = validation(f, kind === "Update", imp); return `        ${a.join(" ")}${a.length ? " " : ""}${javaType(f)} ${f.name}`; }).join(",\n");
    files[`${P}/application/dto/request/${kind}${R}Request.java`] = `${head(pkg, "application.dto.request", imp)}/**
 * ${kind === "Create" ? `Body of POST ${n.path}` : `Body of PUT ${n.path}/{id}: a full replacement, every field is given`}. Validated with Jakarta Validation before
 * the service runs (a violation is a 400 validation_failed problem listing each field); unknown JSON properties are rejected.${kind === "Create" && r.fields.some((f) => f.defaultValue !== undefined) ? `\n * Omitted ${r.fields.filter((f) => f.defaultValue !== undefined).map((f) => `${f.name} (default ${f.defaultValue})`).join(", ")}.` : ""}
 */
public record ${kind}${R}Request(
${comps}) {
}
`;
  }
  {
    const imp = new Set(["java.time.Instant", "java.util.UUID"]);
    if (r.fields.some((f) => f.type === "decimal")) { imp.add("java.math.BigDecimal"); imp.add("com.fasterxml.jackson.annotation.JsonFormat"); }
    const comps = r.fields.map((f) => `        ${f.type === "decimal" ? "@JsonFormat(shape = JsonFormat.Shape.STRING) " : ""}${javaType(f)} ${f.name}`).join(",\n");
    files[`${P}/application/dto/response/${R}Response.java`] = `${head(pkg, "application.dto.response", imp)}/**
 * A ${n.resource} as the API returns it.${r.fields.some((f) => f.type === "decimal") ? " Decimal amounts are JSON strings (\"12.50\"): their exact value survives every client." : ""} Internal columns (version) never leave the service.
 */
public record ${R}Response(
        UUID id,
${comps},
        Instant createdAt,
        Instant updatedAt) {
}
`;
  }

  // ---------------------------------------------------------------- mapper
  {
    const setters = (src: string) => r.fields.map((f) => {
      const v = f.type === "string" || f.type === "text" ? (f.required ? `${src}.${f.name}().strip()` : `${src}.${f.name}() == null ? null : ${src}.${f.name}().strip()`) : `${src}.${f.name}()`;
      return f.type === "boolean" && f.defaultValue !== undefined
        ? `        if (${src}.${f.name}() != null) {\n            entity.set${f.name[0]!.toUpperCase()}${f.name.slice(1)}(${src}.${f.name}());\n        }`
        : `        entity.set${f.name[0]!.toUpperCase()}${f.name.slice(1)}(${v});`;
    }).join("\n");
    files[`${P}/application/mapper/${R}Mapper.java`] = `${head(pkg, "application.mapper", [`${pkg}.application.dto.request.Create${R}Request`, `${pkg}.application.dto.request.Update${R}Request`, `${pkg}.application.dto.response.${R}Response`, `${pkg}.infrastructure.entity.${R}Entity`, "org.springframework.stereotype.Component"])}/** Converts between the API records and the entity; text is trimmed here, once. */
@Component
public class ${R}Mapper {

    public ${R}Entity toEntity(Create${R}Request request) {
        ${R}Entity entity = ${R}Entity.create();
${setters("request")}
        return entity;
    }

    public void update(${R}Entity entity, Update${R}Request request) {
${setters("request")}
    }

    public ${R}Response toResponse(${R}Entity entity) {
        return new ${R}Response(entity.getId(), ${r.fields.map((f) => `entity.${f.type === "boolean" ? "is" : "get"}${f.name[0]!.toUpperCase()}${f.name.slice(1)}()`).join(", ")}, entity.getCreatedAt(), entity.getUpdatedAt());
    }
}
`;
  }

  // ---------------------------------------------------------------- service
  {
    const imp = new Set([`${pkg}.application.dto.request.Create${R}Request`, `${pkg}.application.dto.request.Update${R}Request`, `${pkg}.application.dto.response.PageResponse`, `${pkg}.application.dto.response.${R}Response`, `${pkg}.application.mapper.${R}Mapper`, `${pkg}.infrastructure.entity.${R}Entity`, `${pkg}.infrastructure.persistence.${R}Repository`, `${pkg}.infrastructure.persistence.${R}Specifications`, `${pkg}.shared.exception.ConflictException`, `${pkg}.shared.exception.ResourceNotFoundException`, `${pkg}.shared.validation.PageRequests`, "java.util.Set", "java.util.UUID", "lombok.RequiredArgsConstructor", "org.hibernate.exception.ConstraintViolationException", "org.springframework.dao.DataIntegrityViolationException", "org.springframework.orm.ObjectOptimisticLockingFailureException", "org.springframework.stereotype.Service", "org.springframework.transaction.annotation.Transactional"]);
    if (r.fields.some((f) => f.type === "decimal" && f.filter)) imp.add("java.math.BigDecimal");
    const U = (f: FieldSpec) => `${f.name[0]!.toUpperCase()}${f.name.slice(1)}`;
    const ukConst = uniq.map((f) => `    /** the database constraint that makes ${f.name} unique (V${o.migrationVersion}__create_${n.table}.sql) */\n    static final String ${column(f).toUpperCase()}_CONSTRAINT = ${javaStr(`uk_${n.table}_${column(f)}`)};`).join("\n");
    // the detail names the field, never its value: a problem detail must not echo caller input
    const checkCreate = uniq.map((f) => `        if (repository.existsBy${U(f)}(request.${f.name}().strip())) {\n            throw duplicate${U(f)}();\n        }`).join("\n");
    const checkUpdate = uniq.map((f) => `        if (repository.existsBy${U(f)}AndIdNot(request.${f.name}().strip(), id)) {\n            throw duplicate${U(f)}();\n        }`).join("\n");
    const dupMethods = uniq.map((f) => `    private static ConflictException duplicate${U(f)}() {\n        return new ConflictException("a ${n.resource} with this ${f.name} already exists");\n    }`).join("\n\n");
    const constraintMap = uniq.length ? uniq.map((f) => `        if (violates(e, ${column(f).toUpperCase()}_CONSTRAINT)) {\n            return duplicate${U(f)}();\n        }`).join("\n") : "";
    const filterParams = filters.map((f) => `${javaType(f)} ${f.name}`).join(", ");
    files[`${P}/application/service/${R}Service.java`] = `${head(pkg, "application.service", imp)}/**
 * Business operations on ${n.table}. Each public method is one transaction: reads are read-only, writes commit or roll back as a whole.
 *
 * Uniqueness is checked twice on purpose: the first check gives a clear 409 in the common case; the database constraint is the
 * authority when two requests race past that check, and its violation is turned into the same 409.${ex}
 */
@Service
@RequiredArgsConstructor
public class ${R}Service {

    /** fields the list endpoint may sort by */
    static final Set<String> SORTABLE = Set.of(${sorts.map(javaStr).join(", ")});
    static final String DEFAULT_SORT = "createdAt,desc";
    static final int MAX_PAGE_SIZE = ${r.maxPageSize};
${ukConst ? `${ukConst}\n` : ""}
    private final ${R}Repository repository;
    private final ${R}Mapper mapper;

    @Transactional
    public ${R}Response create(Create${R}Request request) {
${checkCreate}
        ${R}Entity entity = mapper.toEntity(request);
        return mapper.toResponse(saveAndFlush(entity));
    }

    @Transactional(readOnly = true)
    public PageResponse<${R}Response> list(${filterParams}${filterParams ? ", " : ""}int page, int size, String sort) {
        var pageable = PageRequests.of(page, size, sort, SORTABLE, DEFAULT_SORT, MAX_PAGE_SIZE);
        var spec = ${R}Specifications.matching(${filters.map((f) => f.name).join(", ")});
        return PageResponse.of(repository.findAll(spec, pageable).map(mapper::toResponse));
    }

    @Transactional(readOnly = true)
    public ${R}Response find(UUID id) {
        return mapper.toResponse(load(id));
    }

    @Transactional
    public ${R}Response update(UUID id, Update${R}Request request) {
        ${R}Entity entity = load(id);
${checkUpdate}
        mapper.update(entity, request);
        return mapper.toResponse(saveAndFlush(entity));
    }

    /** Deleting an id that does not exist is a 404: the caller learns the resource was not there. */
    @Transactional
    public void delete(UUID id) {
        repository.delete(load(id));
    }

    private ${R}Entity load(UUID id) {
        return repository.findById(id).orElseThrow(() -> new ResourceNotFoundException(${javaStr(n.resource)}, id));
    }

    /** writes now (not at commit) so a constraint violation is reported here, as a 409, inside this transaction */
    private ${R}Entity saveAndFlush(${R}Entity entity) {
        try {
            return repository.saveAndFlush(entity);
        } catch (DataIntegrityViolationException e) {
            throw translate(e);
        } catch (ObjectOptimisticLockingFailureException e) {
            throw new ConflictException("the ${n.resource} was changed by another request; read it again and retry");
        }
    }

    private RuntimeException translate(DataIntegrityViolationException e) {
${constraintMap}
        return e; // any other integrity failure is unexpected: a 500 that reveals nothing
    }

    /** true when the cause chain names the given database constraint */
    static boolean violates(Throwable e, String constraint) {
        for (Throwable t = e; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t instanceof ConstraintViolationException c && constraint.equalsIgnoreCase(c.getConstraintName())) {
                return true;
            }
        }
        return false;
    }
${dupMethods ? `\n${dupMethods}\n` : ""}}
`;
  }

  // ---------------------------------------------------------------- controller
  {
    const imp = new Set([`${pkg}.application.dto.request.Create${R}Request`, `${pkg}.application.dto.request.Update${R}Request`, `${pkg}.application.dto.response.PageResponse`, `${pkg}.application.dto.response.${R}Response`, `${pkg}.application.service.${R}Service`, "jakarta.validation.Valid", "java.net.URI", "java.util.UUID", "lombok.RequiredArgsConstructor", "org.springframework.http.ResponseEntity", "org.springframework.security.access.prepost.PreAuthorize", "org.springframework.web.bind.annotation.DeleteMapping", "org.springframework.web.bind.annotation.GetMapping", "org.springframework.web.bind.annotation.PathVariable", "org.springframework.web.bind.annotation.PostMapping", "org.springframework.web.bind.annotation.PutMapping", "org.springframework.web.bind.annotation.RequestBody", "org.springframework.web.bind.annotation.RequestMapping", "org.springframework.web.bind.annotation.RequestParam", "org.springframework.web.bind.annotation.ResponseStatus", "org.springframework.web.bind.annotation.RestController", "org.springframework.http.HttpStatus", "org.springframework.web.servlet.support.ServletUriComponentsBuilder"]);
    const filterArgs = filters.map((f) => `            @RequestParam(required = false) ${javaType(f)} ${f.name},`).join("\n");
    // a service named like the resource (prefix /products) serves /products/products: the starter requires that to be declared
    const repeats = o.servicePrefix === n.path;
    if (repeats) imp.add("com.pso.spring.autoconfigure.RepeatsServicePrefix");
    files[`${P}/application/rest/${R}Controller.java`] = `${head(pkg, "application.rest", imp)}/**
 * REST endpoints of ${n.table}. The mapping is ${javaStr(n.path)}: PSO adds the service prefix once${o.servicePrefix ? ` (served at ${o.servicePrefix}${n.path})` : ""}.
 *
 * Authentication is enforced by the PSO security starter (a valid JWT from the configured issuer); authorization is declared on each
 * method: reading needs the ${n.readScope} scope, writing ${n.writeScope}. Business logic lives in ${R}Service, not here.${ex}
 */
@RestController
@RequestMapping(${javaStr(n.path)})${repeats ? "\n@RepeatsServicePrefix" : ""}
@RequiredArgsConstructor
public class ${R}Controller {

    private final ${R}Service service;

    @PostMapping
    @PreAuthorize("hasAuthority('SCOPE_${n.writeScope}')")
    public ResponseEntity<${R}Response> create(@Valid @RequestBody Create${R}Request request) {
        ${R}Response created = service.create(request);
        URI location = ServletUriComponentsBuilder.fromCurrentRequestUri().path("/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }

    @GetMapping
    @PreAuthorize("hasAuthority('SCOPE_${n.readScope}')")
    public PageResponse<${R}Response> list(
${filterArgs}
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "${r.defaultPageSize}") int size,
            @RequestParam(required = false) String sort) {
        return service.list(${[...filters.map((f) => f.name), "page", "size", "sort"].join(", ")});
    }

    @GetMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_${n.readScope}')")
    public ${R}Response find(@PathVariable UUID id) {
        return service.find(id);
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_${n.writeScope}')")
    public ${R}Response update(@PathVariable UUID id, @Valid @RequestBody Update${R}Request request) {
        return service.update(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasAuthority('SCOPE_${n.writeScope}')")
    public void delete(@PathVariable UUID id) {
        service.delete(id);
    }
}
`;
  }

  // ---------------------------------------------------------------- migration
  {
    const cols = r.fields.map((f) => {
      const checks: string[] = [];
      if ((f.type === "string" || f.type === "text") && f.minLength) checks.push(`char_length(${column(f)}) >= ${f.minLength}`);
      if ((f.type === "decimal" || f.type === "integer" || f.type === "long") && f.min !== undefined) checks.push(`${column(f)} >= ${f.min}`);
      if ((f.type === "decimal" || f.type === "integer" || f.type === "long") && f.max !== undefined) checks.push(`${column(f)} <= ${f.max}`);
      const def = f.type === "boolean" ? ` DEFAULT ${f.defaultValue === false ? "FALSE" : "TRUE"}` : "";
      const rest = [f.required || f.type === "boolean" ? "NOT NULL" : "", def.trim(), checks.length ? `CHECK (${checks.join(" AND ")})` : ""].filter(Boolean).join(" ");
      return `    ${column(f).padEnd(12)} ${rest ? `${sqlType(f).padEnd(16)} ${rest}` : sqlType(f)},`;
    }).join("\n");
    const indexes = [
      ...r.fields.filter((f) => f.sortable && !f.unique).map((f) => `CREATE INDEX ix_${n.table}_${column(f)} ON ${n.table} (${f.type === "string" ? `lower(${column(f)})` : column(f)});`),
      `CREATE INDEX ix_${n.table}_created_at ON ${n.table} (created_at, id);`,
    ];
    files[`src/main/resources/db/migration/V${o.migrationVersion}__create_${n.table}.sql`] = `-- ${n.Resources}: generated by PSO. Migrations are append-only: never edit an applied version, add a new one (V${o.migrationVersion + 1}__...).
-- Unique values are enforced HERE (the service turns a violation into 409); timestamps are UTC (TIMESTAMPTZ);
-- money is an exact NUMERIC, never a floating-point type.
CREATE TABLE ${n.table} (
    id           UUID             PRIMARY KEY,
${cols}
    created_at   TIMESTAMPTZ      NOT NULL,
    updated_at   TIMESTAMPTZ      NOT NULL,
    version      BIGINT           NOT NULL DEFAULT 0${uniq.map((f) => `,\n    CONSTRAINT uk_${n.table}_${column(f)} UNIQUE (${column(f)})`).join("")}
);

-- sorting and filtering run in the database: index what the list endpoint orders by
${indexes.join("\n")}
`;
  }

  // ---------------------------------------------------------------- tests
  files[`${T}/application/rest/${R}ControllerTests.java`] = springCrudTest(r, o);
  if (o.withShared) Object.assign(files, springSharedFiles(pkg));
  return files;
}

function springCrudTest(r: ResourceSpec, o: SpringCrudOptions): string {
  const n = names(r), R = n.Resource, pkg = o.pkg;
  const base = `${o.servicePrefix}${n.path}`;
  const body = (i: number, overrides: Record<string, string> = {}) => `"{${r.fields.map((f) => `\\"${f.name}\\":${(overrides[f.name] ?? sample(f, i)).replace(/"/g, '\\"')}`).join(",")}}"`;
  const uniq = r.fields.find((f) => f.unique);
  const required = r.fields.find((f) => f.required);
  const filterText = r.fields.find((f) => f.filter === "contains");
  return `${head(pkg, "application.rest", ["com.fasterxml.jackson.databind.JsonNode", "com.fasterxml.jackson.databind.ObjectMapper", "com.pso.test.PsoTestJwt", "java.util.ArrayList", "java.util.List", "java.util.concurrent.Callable", "java.util.concurrent.ExecutorService", "java.util.concurrent.Executors", "java.util.concurrent.Future", "org.junit.jupiter.api.AfterAll", "org.junit.jupiter.api.BeforeEach", "org.junit.jupiter.api.Test", "org.springframework.beans.factory.annotation.Autowired", "org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc", "org.springframework.boot.test.context.SpringBootTest", "org.springframework.http.MediaType", "org.springframework.jdbc.core.JdbcTemplate", "org.springframework.test.context.ActiveProfiles", "org.springframework.test.context.DynamicPropertyRegistry", "org.springframework.test.context.DynamicPropertySource", "org.springframework.test.web.servlet.MockMvc", "org.springframework.test.web.servlet.MvcResult", "static org.assertj.core.api.Assertions.assertThat", "static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete", "static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get", "static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post", "static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put", "static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath", "static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status", "static org.hamcrest.Matchers.startsWith"])}/**
 * The ${n.resource} API end to end inside the service: the real HTTP layer (MockMvc), real JWT validation (a local JWKS), real
 * PostgreSQL (embedded) with the real Flyway migrations. Nothing is mocked.
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
class ${R}ControllerTests {

    private static final PsoTestJwt JWT = new PsoTestJwt();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BASE = ${javaStr(base)};

    @Autowired
    MockMvc mvc;

    @Autowired
    JdbcTemplate jdbc;

    @DynamicPropertySource
    static void jwt(DynamicPropertyRegistry registry) {
        registry.add("pso.security.jwt.jwks-uri", JWT::jwksUri);
        registry.add("pso.security.jwt.issuer", () -> PsoTestJwt.ISSUER);
        registry.add("pso.security.jwt.audience", () -> PsoTestJwt.AUDIENCE);
        registry.add("pso.security.jwt.algorithms", () -> "ES256");
    }

    @AfterAll
    static void stop() {
        JWT.close();
    }

    @BeforeEach
    void empty() {
        jdbc.update("DELETE FROM ${n.table}");
    }

    private static String bearer(String... scopes) {
        return "Bearer " + JWT.token("user-1", List.of(scopes), List.of());
    }

    /** POST of a JSON body with a token holding the given scopes */
    private MvcResult send(String json, String... scopes) throws Exception {
        return mvc.perform(post(BASE).header("Authorization", bearer(scopes)).contentType(MediaType.APPLICATION_JSON).content(json)).andReturn();
    }

    /** valid bodies, each with distinct unique values */
    private static String sample(int i) {
        return switch (i) {
${[0, 1, 2, 3].map((i) => `            case ${i} -> ${body(i)};`).join("\n")}
            default -> throw new IllegalArgumentException("sample " + i);
        };
    }

    @Test
    void flywayCreatedTheTableWithItsConstraints() {
        assertThat(jdbc.queryForObject("SELECT count(*) FROM flyway_schema_history WHERE version = '${o.migrationVersion}' AND success", Integer.class)).isEqualTo(1);
    }

    @Test
    void createReadUpdateDelete() throws Exception {
        MvcResult created = send(sample(0), "${n.writeScope}");
        assertThat(created.getResponse().getStatus()).isEqualTo(201);
        JsonNode p = JSON.readTree(created.getResponse().getContentAsString());
        String id = p.get("id").asText();
        assertThat(created.getResponse().getHeader("Location")).endsWith(BASE + "/" + id);
        assertThat(p.has("version")).as("internal columns never leave the service").isFalse();
        assertThat(p.get("createdAt").asText()).endsWith("Z");
${r.fields.filter((f) => f.type === "decimal").map((f) => `        assertThat(p.get(${javaStr(f.name)}).isTextual()).as("exact decimal as a string").isTrue();`).join("\n")}

        mvc.perform(get(BASE + "/" + id).header("Authorization", bearer("${n.readScope}"))).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id));

        mvc.perform(put(BASE + "/" + id).header("Authorization", bearer("${n.writeScope}")).contentType(MediaType.APPLICATION_JSON).content(sample(1)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id));

        mvc.perform(delete(BASE + "/" + id).header("Authorization", bearer("${n.writeScope}"))).andExpect(status().isNoContent());
        mvc.perform(get(BASE + "/" + id).header("Authorization", bearer("${n.readScope}"))).andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("PSO_HTTP_NOT_FOUND"));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM ${n.table}", Integer.class)).isZero();
    }

    @Test
    void invalidBodiesAreRejectedWithTheFieldsAtFault() throws Exception {
        MvcResult r = send("{}", "${n.writeScope}");
        assertThat(r.getResponse().getStatus()).isEqualTo(400);
        JsonNode problem = JSON.readTree(r.getResponse().getContentAsString());
        assertThat(problem.get("code").asText()).isEqualTo("PSO_VALIDATION_FAILED");
${required ? `        assertThat(problem.get("errors").toString()).contains(${javaStr(required.name)});` : ""}
        assertThat(send("{not json", "${n.writeScope}").getResponse().getStatus()).isEqualTo(400);
${o.strictJson === false ? "" : `        assertThat(send(sample(0).replaceFirst("\\\\{", "{\\"unexpected\\":1,"), "${n.writeScope}").getResponse().getStatus()).as("a property outside the contract is refused").isEqualTo(400);`}
        assertThat(jdbc.queryForObject("SELECT count(*) FROM ${n.table}", Integer.class)).isZero();
    }
${uniq ? `
    @Test
    void aDuplicate${uniq.name[0]!.toUpperCase()}${uniq.name.slice(1)}IsAConflict() throws Exception {
        assertThat(send(sample(0), "${n.writeScope}").getResponse().getStatus()).isEqualTo(201);
        MvcResult dup = send(sample(0), "${n.writeScope}");
        assertThat(dup.getResponse().getStatus()).isEqualTo(409);
        JsonNode problem = JSON.readTree(dup.getResponse().getContentAsString());
        assertThat(problem.get("code").asText()).isEqualTo("PSO_HTTP_CONFLICT");
        assertThat(problem.get("detail").asText()).contains("already exists");
    }

    /** concurrent creations of the same ${uniq.name} race past the first check: the database constraint still lets exactly one win */
    @Test
    void concurrentDuplicatesCreateExactlyOneRow() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Callable<Integer>> calls = new ArrayList<>();
            for (int i = 0; i < 8; i++) {
                calls.add(() -> send(sample(2), "${n.writeScope}").getResponse().getStatus());
            }
            List<Integer> statuses = new ArrayList<>();
            for (Future<Integer> f : pool.invokeAll(calls)) {
                statuses.add(f.get());
            }
            assertThat(statuses).containsOnly(201, 409);
            assertThat(statuses.stream().filter(s -> s == 201).count()).isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM ${n.table}", Integer.class)).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }
` : ""}
    @Test
    void missingResourcesAndMalformedIds() throws Exception {
        mvc.perform(get(BASE + "/00000000-0000-0000-0000-000000000000").header("Authorization", bearer("${n.readScope}"))).andExpect(status().isNotFound());
        mvc.perform(get(BASE + "/not-a-uuid").header("Authorization", bearer("${n.readScope}"))).andExpect(status().isBadRequest());
        mvc.perform(delete(BASE + "/00000000-0000-0000-0000-000000000000").header("Authorization", bearer("${n.writeScope}"))).andExpect(status().isNotFound());
    }

    @Test
    void authenticationAndAuthorization() throws Exception {
        mvc.perform(get(BASE)).andExpect(status().isUnauthorized());
        mvc.perform(get(BASE).header("Authorization", "Bearer not-a-token")).andExpect(status().isUnauthorized());
        mvc.perform(get(BASE).header("Authorization", bearer("other:scope"))).andExpect(status().isForbidden());
        assertThat(send(sample(0), "${n.readScope}").getResponse().getStatus()).as("reading does not allow writing").isEqualTo(403);
    }

    @Test
    void paginationSortingAndFilteringRunInTheDatabase() throws Exception {
        for (int i = 0; i < 3; i++) {
            assertThat(send(sample(i), "${n.writeScope}").getResponse().getStatus()).isEqualTo(201);
        }
        mvc.perform(get(BASE + "?size=2&page=0&sort=createdAt,asc").header("Authorization", bearer("${n.readScope}")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items.length()").value(2))
            .andExpect(jsonPath("$.totalItems").value(3))
            .andExpect(jsonPath("$.totalPages").value(2))
            .andExpect(jsonPath("$.page").value(0))
            .andExpect(jsonPath("$.size").value(2));
        mvc.perform(get(BASE + "?size=2&page=1&sort=createdAt,asc").header("Authorization", bearer("${n.readScope}"))).andExpect(jsonPath("$.items.length()").value(1));
        mvc.perform(get(BASE + "?sort=version").header("Authorization", bearer("${n.readScope}"))).andExpect(status().isBadRequest()).andExpect(jsonPath("$.detail").value(startsWith("sort must be one of")));
        mvc.perform(get(BASE + "?size=${r.maxPageSize + 1}").header("Authorization", bearer("${n.readScope}"))).andExpect(status().isBadRequest());
        mvc.perform(get(BASE + "?page=-1").header("Authorization", bearer("${n.readScope}"))).andExpect(status().isBadRequest());
${uniq ? `        mvc.perform(get(BASE + "?${uniq.name}=" + JSON.readTree(sample(1)).get(${javaStr(uniq.name)}).asText()).header("Authorization", bearer("${n.readScope}"))).andExpect(jsonPath("$.totalItems").value(1));` : ""}
${filterText ? `        mvc.perform(get(BASE + "?${filterText.name}=%25").header("Authorization", bearer("${n.readScope}"))).andExpect(jsonPath("$.totalItems").value(0));` : ""}
    }
}
`;
}
