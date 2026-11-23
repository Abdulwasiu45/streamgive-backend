import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const DEFAULT_DATABASE_URL = 'postgresql://streamgive:streamgive@localhost:5432/streamgive';
const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
process.env.DATABASE_URL = databaseUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
});
