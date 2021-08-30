import { cac, config, buildUrl, DB } from './deps.ts';

config({ safe: false });
const cli = cac('omhh');

interface UpOptions {
    db: string;
    api: string;
    token: string;
    file: string;
}

cli.command('add [...fdcIds]>', 'adds (or overwrites) foods to Oh My Heart and Home database')
    .option('--db', 'source sqlite3 database file path', { default: './food-db.sqlite3' })
    .option('--api', 'omhh api uri')
    .option('--token', 'omhh api token')
    .option('--file', 'file of fdc ids')
    .action(async (fdcIds: string[] = [], options: UpOptions) => {
        if (fdcIds[fdcIds.length - 1] === 'main.ts') {
            fdcIds.pop();
        }

        const { OMHH_API_URI, OMHH_API_TOKEN } = Deno.env.toObject();

        const {
            db: dbFilePath,
            api: apiBase = OMHH_API_URI,
            token = OMHH_API_TOKEN,
            file,
        } = options;

        // get a resolved list of fdc-ids to check
        if (file != null) {
            const text = await Deno.readTextFile(file);
            fdcIds.push(...text.split('\n').map(id => id.trim()));
        }

        // for each new id, look them up in the database and construct the mutation
        const db = new DB(dbFilePath, { mode: 'read' });
        let mutation: unknown = undefined;
        try {

            type FdcIdQueryParam = { fdcId: string };

            type FoodQueryTuple = [number, string, string];
            // deno-lint-ignore camelcase
            type FoodQueryEntry = { fdc_id: number, description: string, data_type: string };

            const foodQuery = db.prepareQuery<FoodQueryTuple, FoodQueryEntry, FdcIdQueryParam>(`
                select f.fdc_id, f.description, f.data_type 
                from food f where f.fdc_id = :fdcId
            `.trim());

            type NutrientsQueryTuple = [string, number, string];
            // deno-lint-ignore camelcase
            type NutrientsQueryEntry = { name: string, amount: number, unit_name: string };
            const nutrientsQuery = db.prepareQuery<NutrientsQueryTuple, NutrientsQueryEntry, FdcIdQueryParam>(`
                select n.name, fn.amount, n.unit_name from food_nutrient fn
                inner join nutrient n on fn.nutrient_id = n.id
                where fn.fdc_id = :fdcId
            `.trim());

            type BrandQueryTuple = [string, string, string, number, string, string];
            // deno-lint-ignore camelcase
            type BrandQueryEntry = { brand_owner?: string, brand_name?: string, subbrand_name?: string, serving_size?: number, serving_size_unit?: string, household_serving_fulltext?: string };
            const brandQuery = db.prepareQuery<BrandQueryTuple, BrandQueryEntry, FdcIdQueryParam>(`
                select brand_owner, ifnull(brand_name,'') as brand_name, ifnull(subbrand_name,'') as subbrand_name, ifnull(serving_size,0) as serving_size, ifnull(serving_size_unit,'') as serving_size_unit, ifnull(household_serving_fulltext,'') as household_serving_fulltext from branded_food
                where fdc_id = :fdcId
            `.trim());

            type PortionsQueryTuple = [number, string, number, string, string];
            // deno-lint-ignore camelcase
            type PortionsQueryEntry = { amount: number, unit: string, gram_weight: number, portion_description: string, modifier: string };
            const portionsQuery = db.prepareQuery<PortionsQueryTuple, PortionsQueryEntry, FdcIdQueryParam>(`
                select fp.amount, m.name as unit, fp.gram_weight, ifnull(fp.portion_description,'') as portion_description, ifnull(fp.modifier,'') as modifier from food_portion fp
                inner join measure_unit m on fp.measure_unit_id = m.id
                where fp.fdc_id = :fdcId
            `.trim());

            const mutations = fdcIds.map(fdcId => {
                // deno-lint-ignore camelcase
                const { fdc_id, description, data_type: source } = foodQuery.oneEntry({ fdcId });

                let brand: BrandQueryEntry = {}
                try {
                    brand = brandQuery.oneEntry({ fdcId });
                } catch (_error) {
                    // ignore
                }

                let nutrients: NutrientsQueryEntry[] = [];
                try {
                    nutrients = nutrientsQuery.allEntries({ fdcId }).map(n => ({ _key: n, ...n }));
                } catch (_error) {
                    // ignore
                }

                let portions: PortionsQueryEntry[] = [];
                try {
                    portions = portionsQuery.allEntries({ fdcId }).map(p => ({ _key: p.unit, ...p }));
                } catch (_error) {
                    // ignore
                }

                // deno-lint-ignore camelcase
                const { brand_owner, brand_name, subbrand_name, serving_size, serving_size_unit, household_serving_fulltext } = brand;
                return {
                    createOrReplace: {
                        _id: fdc_id,
                        _type: 'food',
                        description,
                        fdc_id,
                        source,
                        nutrients,
                        portions,
                        brand_owner,
                        brand_name,
                        subbrand_name,
                        serving_size,
                        serving_size_unit,
                        household_serving_fulltext,
                    }
                };
            });

            mutation = { mutations }
        } catch (error) {
            return console.error(error);
        } finally {
            db.close(true)
        }

        // post mutation
        if (mutation) {
            const postApi = buildUrl(apiBase, { path: ['data', 'mutate', 'production'] });
            try {
                const res = await fetch(
                    postApi,
                    {
                        method: 'post',
                        headers: {
                            'Content-type': 'application/json',
                            Authorization: `Bearer ${token}`
                        },
                        body: JSON.stringify(mutation)
                    }
                );
                const result = await res.json();
                console.log(result);
            } catch (error) {
                console.error(error);
            }
        }
    });

cli.help();
cli.version('1.0.0');
cli.parse();