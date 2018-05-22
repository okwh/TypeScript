/// <reference path='fourslash.ts' />

/////** This is class c2 without constuctor*/
////class c/*1*/2 {
////}
////var i/*2*/2 = new c/*28*/2(/*3*/);
////var i2/*4*/_c = c/*5*/2;
////class c/*6*/3 {
////    /** Constructor comment*/
////    constructor() {
////    }
////}
////var i/*7*/3 = new c/*29*/3(/*8*/);
////var i3/*9*/_c = c/*10*/3;
/////** Class comment*/
////class c/*11*/4 {
////    /** Constructor comment*/
////    constructor() {
////    }
////}
////var i/*12*/4 = new c/*30*/4(/*13*/);
////var i4/*14*/_c = c/*15*/4;
/////** Class with statics*/
////class c/*16*/5 {
////    static s1: number;
////}
////var i/*17*/5 = new c/*31*/5(/*18*/);
////var i5_/*19*/c = c/*20*/5;
/////** class with statics and constructor*/
////class c/*21*/6 {
////    /** s1 comment*/
////    static s1: number;
////    /** constructor comment*/
////    constructor() {
////    }
////}
////var i/*22*/6 = new c/*32*/6(/*23*/);
////var i6/*24*/_c = c/*25*/6;
/////*26*/
////class a {
////    /**
////    constructor for a
////    @param a this is my a
////    */
////    constructor(a: string) {
////    }
////}
////new a(/*27*/"Hello");
////module m {
////    export module m2 {
////        /** class comment */
////        export class c1 {
////            /** constructor comment*/
////            constructor() {
////            }
////        }
////    }
////}
////var myVar = new m.m2.c/*33*/1();

verify.quickInfos({
    1: ["class c2", "This is class c2 without constuctor"],
    2: "var i2: c2"
});

verify.signatureHelp({ marker: "3", docComment: "" });

verify.quickInfos({
    4: "var i2_c: typeof c2",
    5: ["class c2", "This is class c2 without constuctor"],
    6: "class c3",
    7: "var i3: c3"
});

verify.signatureHelp({ marker: "8", docComment: "Constructor comment" });

verify.quickInfos({
    9: "var i3_c: typeof c3",
    10: "class c3",
    11: ["class c4", "Class comment"],
    12: "var i4: c4"
});

verify.signatureHelp({ marker: "13", docComment: "Constructor comment" });

verify.quickInfos({
    14: "var i4_c: typeof c4",
    15: ["class c4", "Class comment"],
    16: ["class c5", "Class with statics"],
    17: "var i5: c5"
});

verify.signatureHelp({ marker: "18", docComment: "" });

verify.quickInfos({
    19: "var i5_c: typeof c5",
    20: ["class c5", "Class with statics"],
    21: ["class c6", "class with statics and constructor"],
    22: "var i6: c6"
});

verify.signatureHelp({ marker: "23", docComment: "constructor comment" });

verify.quickInfos({
    24: "var i6_c: typeof c6",
    25: ["class c6", "class with statics and constructor"]
});

verify.completions({
    marker: "26",
    includes: [
        { name: "c2", text: "class c2", documentation: "This is class c2 without constuctor" },
        { name: "i2", text: "var i2: c2" },
        { name: "i2_c", text: "var i2_c: typeof c2" },
        { name: "c3", text: "class c3" },
        { name: "i3", text: "var i3: c3" },
        { name: "i3_c", text: "var i3_c: typeof c3" },
        { name: "c4", text: "class c4", documentation: "Class comment" },
        { name: "i4", text: "var i4: c4" },
        { name: "i4_c", text: "var i4_c: typeof c4" },
        { name: "c5", text: "class c5", documentation: "Class with statics" },
        { name: "i5", text: "var i5: c5" },
        { name: "i5_c", text: "var i5_c: typeof c5" },
        { name: "c6", text: "class c6", documentation: "class with statics and constructor" },
        { name: "i6", text: "var i6: c6" },
        { name: "i6_c", text: "var i6_c: typeof c6" },
    ],
});

verify.signatureHelp({
    marker: "27",
    docComment: "constructor for a",
    parameterDocComment: "this is my a",
    tags: [{ name: "param", text: "a this is my a" }],
});

verify.quickInfos({
    28: "constructor c2(): c2",
    29: ["constructor c3(): c3", "Constructor comment"],
    30: ["constructor c4(): c4", "Constructor comment"],
    31: "constructor c5(): c5",
    32: ["constructor c6(): c6", "constructor comment"],
    33: ["constructor m.m2.c1(): m.m2.c1", "constructor comment"]
});
