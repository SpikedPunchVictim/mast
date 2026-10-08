import { connect as rootConnect } from '@x/core';
import { connect } from '@x/core/client';
import { setup } from '@x/core/testing';
import { helper } from '@x/core/helpers';
import { Button } from '@x/ui';
import { Button as B2 } from '@x/ui/components/Button';
export function main(): void { rootConnect(); connect(); setup(); helper(); Button(); B2(); }
