import { Body, Controller, Module, Post, type Type } from '@nestjs/common';
import {
  MODULE_METADATA,
  PARAMTYPES_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { GATEWAY_METADATA } from '@nestjs/websockets/constants.js';
import { WsParamtype } from '@nestjs/websockets/enums/ws-paramtype.enum.js';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { isZodDto, zodDto } from './zod-dto.js';

/** Every controller and WebSocket gateway reachable from `root` through module imports. */
function collectHandlerClasses(root: Type): Type[] {
  const seen = new Set<unknown>();
  const classes: Type[] = [];
  const visit = (module: unknown) => {
    if (typeof module !== 'function' || seen.has(module)) return;
    seen.add(module);
    classes.push(...(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, module) ?? []));
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? [];
    for (const provider of providers) {
      if (typeof provider === 'function' && Reflect.getMetadata(GATEWAY_METADATA, provider)) {
        classes.push(provider as Type);
      }
    }
    for (const imported of Reflect.getMetadata(MODULE_METADATA.IMPORTS, module) ?? []) {
      visit(imported?.module ?? imported); // plain modules and dynamic modules
    }
  };
  visit(root);
  return classes;
}

/** Both are stored under the same metadata key; a different number would need its own check. */
const BODY_PARAMTYPES = new Set([String(RouteParamtypes.BODY), String(WsParamtype.PAYLOAD)]);

/**
 * "Class.method(#index)" for every @Body() (controllers) and @MessageBody() (gateways) parameter
 * whose type is not a zodDto class.
 */
function bodiesWithoutZodDto(root: Type): string[] {
  const problems: string[] = [];
  for (const controller of collectHandlerClasses(root)) {
    const prototype = controller.prototype as object;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === 'constructor') continue;
      const args: Record<string, { index: number }> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {};
      const types: unknown[] = Reflect.getMetadata(PARAMTYPES_METADATA, prototype, method) ?? [];
      for (const [key, { index }] of Object.entries(args)) {
        if (!BODY_PARAMTYPES.has(key.split(':')[0])) continue;
        if (!isZodDto(types[index])) problems.push(`${controller.name}.${method}(#${index})`);
      }
    }
  }
  return problems;
}

describe('every @Body() and @MessageBody() is validated', () => {
  it('holds for the whole app', () => {
    expect(bodiesWithoutZodDto(AppModule)).toEqual([]);
  });

  it('detects a body that is not a zodDto (self-check)', () => {
    class GoodDto extends zodDto(z.object({ name: z.string() })) {}
    class PlainDto {
      name!: string;
    }

    @Controller('fixture')
    class FixtureController {
      @Post('good')
      good(@Body() _body: GoodDto) {}

      @Post('bad')
      bad(@Body() _body: PlainDto) {}

      @Post('untyped')
      untyped(@Body() _body: unknown) {}
    }

    @WebSocketGateway()
    class FixtureGateway {
      @SubscribeMessage('good')
      good(@MessageBody() _body: GoodDto) {}

      @SubscribeMessage('bad')
      bad(@MessageBody() _body: PlainDto) {}
    }

    @Module({ controllers: [FixtureController], providers: [FixtureGateway] })
    class FixtureModule {}

    @Module({ imports: [FixtureModule] })
    class RootModule {}

    expect(bodiesWithoutZodDto(RootModule)).toEqual([
      'FixtureController.bad(#0)',
      'FixtureController.untyped(#0)',
      'FixtureGateway.bad(#0)',
    ]);
  });
});
