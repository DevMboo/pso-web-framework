package {{pkg}}.application;

import {{pkg}}.contracts.PingDto;
import {{pkg}}.contracts.PingRequest;
import com.pso.spring.autoconfigure.PsoServiceInfo;
import java.time.Clock;
import java.time.Instant;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

/** Constructor injection through Lombok's @RequiredArgsConstructor: every final field is a dependency. */
@Service
@RequiredArgsConstructor
public class PingService {

    private final PsoServiceInfo service;
    private final Clock clock = Clock.systemUTC();

    public PingDto ping(PingRequest request) {
        return new PingDto(service.name(), request.getMessage(), Instant.now(clock));
    }
}
