"""Edit docs/plan.xml with lxml: each edit names its target by XPath, takes
XML fragments (so prose keeps its <code> elements), and the file is
validated against docs/plan.rng before it is written; nothing is written
when the result does not validate."""
import sys
from lxml import etree

PLAN = str(__import__('pathlib').Path(__file__).resolve().parents[1] / 'docs/plan.xml')
SCHEMA = str(__import__('pathlib').Path(__file__).resolve().parents[1] / 'docs/plan.rng')


class Plan:
    def __init__(self, path=PLAN):
        self.path = path
        self.tree = etree.parse(path, etree.XMLParser(remove_blank_text=False))
        self.root = self.tree.getroot()

    def one(self, xpath):
        found = self.root.xpath(xpath)
        if len(found) != 1:
            raise SystemExit(f'{xpath}: {len(found)} matches, expected 1')
        return found[0]

    @staticmethod
    def fragment(xml):
        return etree.fromstring(xml)

    def replace(self, xpath, xml):
        old = self.one(xpath)
        new = self.fragment(xml)
        new.tail = old.tail
        old.getparent().replace(old, new)
        return new

    def append(self, xpath, xml, before=None):
        parent = self.one(xpath)
        new = self.fragment(xml)
        if before is not None:
            anchor = self.one(before)
            anchor.addprevious(new)
            new.tail = anchor.getprevious().tail if anchor.getprevious() is not None else '\n    '
        else:
            last = parent[-1] if len(parent) else None
            if last is not None:
                new.tail, last.tail = last.tail, (parent.text or '\n  ')
            parent.append(new)
        return new

    def remove(self, xpath):
        old = self.one(xpath)
        parent = old.getparent()
        prev = old.getprevious()
        if prev is not None: prev.tail = old.tail
        parent.remove(old)

    def set(self, xpath, attribute, value):
        self.one(xpath).set(attribute, value)

    def save(self):
        schema = etree.RelaxNG(etree.parse(SCHEMA))
        if not schema.validate(self.tree):
            for error in schema.error_log:
                print(error, file=sys.stderr)
            raise SystemExit('not written: the plan does not validate')
        ids = set(self.root.xpath('//@id'))
        for attribute in self.root.xpath('//@after | //@decision'):
            for ref in attribute.split():
                if ref not in ids:
                    raise SystemExit(f'not written: {ref} is no id')
        for rec in self.root.xpath('//recommendation'):
            if rec.get('option') not in rec.getparent().xpath('option/@id'):
                raise SystemExit(f"not written: {rec.getparent().get('id')} recommends no option of its own")
        self.tree.write(self.path, xml_declaration=True, encoding='UTF-8')
        print('written, valid:', self.path)


class Log(Plan):
    """docs/log.xml, validated against docs/log.rng. Add an entry with
    Log().entry(id, step, kind, status, what, why=None, evidence=None,
    resolution=None).save(); resolve one with .resolve(id, resolution)."""

    def __init__(self):
        root = __import__('pathlib').Path(__file__).resolve().parents[1]
        super().__init__(str(root / 'docs/log.xml'))
        self.schema = str(root / 'docs/log.rng')

    def entry(self, id, step, kind, status, what, why=None, evidence=None, resolution=None):
        import datetime
        e = etree.SubElement(self.root, 'entry', id=id, date=datetime.date.today().isoformat(),
                             step=step, kind=kind, status=status)
        for tag, text in (('what', what), ('why', why), ('evidence', evidence), ('resolution', resolution)):
            if text:
                etree.SubElement(e, tag).text = text
        return self

    def resolve(self, id, resolution):
        e = self.one(f"//entry[@id='{id}']")
        e.set('status', 'resolved')
        r = e.find('resolution')
        if r is None:
            r = etree.SubElement(e, 'resolution')
        r.text = resolution
        return self

    def save(self):
        schema = etree.RelaxNG(etree.parse(self.schema))
        if not schema.validate(self.tree):
            for error in schema.error_log:
                print(error, file=sys.stderr)
            raise SystemExit('not written: the log does not validate')
        etree.indent(self.root, space='  ')
        self.tree.write(self.path, xml_declaration=True, encoding='UTF-8')
        print('written, valid:', self.path)
